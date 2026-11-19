/**
 * Order saga coordinator (part of the Order Service, run by the "order" consumer).
 *
 * Payment and inventory run IN PARALLEL and may finish in any order. Each result event
 * updates its own step on the order. When BOTH steps have reported, the saga makes the final
 * decision — atomically, in the same transaction as the event's completion record:
 *
 *   payment SUCCEEDED + inventory RESERVED -> CONFIRMED  (commit reservation)  -> ORDER_CONFIRMED
 *   payment FAILED                         -> PAYMENT_FAILED   (release stock if reserved) -> ORDER_FAILED
 *   inventory FAILED                       -> INVENTORY_FAILED (refund if paid)            -> ORDER_FAILED
 *
 * Concurrency: two result events for the same order write the same order document, so their
 * transactions conflict and MongoDB serialises them (the driver retries the loser). The loser
 * then sees the winner's step result, so exactly one of them makes the final decision.
 * Compensations are conditional transitions, so they can never run twice.
 */
import { Order, ORDER_STATUS, PAYMENT_STATUS, STEP_STATUS, TERMINAL_ORDER_STATUSES, User } from '../models/index.js';
import { EVENT_TYPES } from '../events/eventTypes.js';
import { createChildEvent } from '../events/eventFactory.js';
import { addToOutbox } from '../outbox/outboxService.js';
import { PermanentError } from '../reliable-event-processor/errors.js';
import { commitReservation, releaseReservation } from './inventory.service.js';
import { refundOrderPayment } from './payment.service.js';

const STEP_FOR_EVENT = {
  [EVENT_TYPES.PAYMENT_COMPLETED]: { step: 'payment', status: STEP_STATUS.SUCCEEDED },
  [EVENT_TYPES.PAYMENT_FAILED]: { step: 'payment', status: STEP_STATUS.FAILED },
  [EVENT_TYPES.INVENTORY_RESERVED]: { step: 'inventory', status: STEP_STATUS.RESERVED },
  [EVENT_TYPES.INVENTORY_FAILED]: { step: 'inventory', status: STEP_STATUS.FAILED },
};

function pushStatus(order, status, note) {
  order.statusHistory.push({ status, note, at: new Date() });
}

/**
 * Applies a PAYMENT_* / INVENTORY_* result event to its order.
 * @returns {{ decision: 'WAITING'|'CONFIRMED'|'FAILED'|'IGNORED' }}
 */
export async function applyStepResult(event, session) {
  const mapping = STEP_FOR_EVENT[event.eventType];
  if (!mapping) throw new PermanentError(`Saga cannot handle ${event.eventType}`);

  const order = await Order.findById(event.payload.orderId).session(session);
  if (!order) throw new PermanentError(`Order ${event.payload.orderId} does not exist`);

  const step = order.fulfillment[mapping.step];
  if (step.status !== STEP_STATUS.PENDING) {
    return { decision: 'IGNORED' }; // this step was already recorded (duplicate result)
  }
  step.status = mapping.status;
  step.reason = event.payload.reason ?? '';
  step.eventId = event.eventId;
  step.updatedAt = new Date();

  if (mapping.step === 'payment') {
    order.paymentStatus = mapping.status === STEP_STATUS.SUCCEEDED ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.FAILED;
  }

  if (TERMINAL_ORDER_STATUSES.includes(order.orderStatus)) {
    await order.save({ session });
    return { decision: 'IGNORED' };
  }

  const payment = order.fulfillment.payment.status;
  const inventory = order.fulfillment.inventory.status;

  // Still waiting for the other step.
  if (payment === STEP_STATUS.PENDING || inventory === STEP_STATUS.PENDING) {
    if (order.orderStatus === ORDER_STATUS.PENDING) {
      order.orderStatus = ORDER_STATUS.PROCESSING;
    }
    pushStatus(order, ORDER_STATUS.PROCESSING, describeStep(mapping, event));
    await order.save({ session });
    return { decision: 'WAITING' };
  }

  pushStatus(order, ORDER_STATUS.PROCESSING, describeStep(mapping, event));
  const customer = await loadCustomer(order.userId, session);

  // Both succeeded -> confirm.
  if (payment === STEP_STATUS.SUCCEEDED && inventory === STEP_STATUS.RESERVED) {
    await commitReservation(order._id, session);
    order.orderStatus = ORDER_STATUS.CONFIRMED;
    pushStatus(order, ORDER_STATUS.CONFIRMED, 'Payment received and stock reserved');
    await order.save({ session });
    await addToOutbox(
      createChildEvent(event, {
        eventType: EVENT_TYPES.ORDER_CONFIRMED,
        aggregateType: 'Order',
        aggregateId: String(order._id),
        payload: { orderId: String(order._id), orderNumber: order.orderNumber, totalAmount: order.totalAmount, customer },
      }),
      session
    );
    return { decision: 'CONFIRMED' };
  }

  // At least one failed -> compensate and fail.
  const paymentFailed = payment === STEP_STATUS.FAILED;
  const stockReleased = inventory === STEP_STATUS.RESERVED ? await releaseReservation(order._id, session) : false;
  const paymentRefunded = payment === STEP_STATUS.SUCCEEDED ? await refundOrderPayment(order._id, session) : false;

  order.orderStatus = paymentFailed ? ORDER_STATUS.PAYMENT_FAILED : ORDER_STATUS.INVENTORY_FAILED;
  order.failureReason = paymentFailed
    ? `Payment failed: ${order.fulfillment.payment.reason || 'declined'}`
    : `Inventory reservation failed: ${order.fulfillment.inventory.reason || 'insufficient stock'}`;
  order.compensation = { paymentRefunded, stockReleased };
  if (paymentRefunded) order.paymentStatus = PAYMENT_STATUS.REFUNDED;
  const notes = [order.failureReason];
  if (paymentRefunded) notes.push('payment refunded (simulated)');
  if (stockReleased) notes.push('reserved stock released');
  pushStatus(order, order.orderStatus, notes.join('; '));
  await order.save({ session });

  await addToOutbox(
    createChildEvent(event, {
      eventType: EVENT_TYPES.ORDER_FAILED,
      aggregateType: 'Order',
      aggregateId: String(order._id),
      payload: {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        orderStatus: order.orderStatus,
        reason: order.failureReason,
        totalAmount: order.totalAmount,
        customer,
        compensation: { paymentRefunded, stockReleased },
      },
    }),
    session
  );
  return { decision: 'FAILED' };
}

function describeStep(mapping, event) {
  if (mapping.step === 'payment') {
    return mapping.status === STEP_STATUS.SUCCEEDED ? 'Payment succeeded (simulated)' : `Payment failed: ${event.payload.reason}`;
  }
  return mapping.status === STEP_STATUS.RESERVED ? 'Stock reserved' : `Stock reservation failed: ${event.payload.reason}`;
}

async function loadCustomer(userId, session) {
  const user = await User.findById(userId).session(session);
  if (!user) throw new PermanentError(`User ${userId} does not exist`);
  return { userId: String(user._id), name: user.name, email: user.email };
}
