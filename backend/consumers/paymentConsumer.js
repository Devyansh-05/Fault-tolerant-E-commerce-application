/**
 * PAYMENT CONSUMER — ORDER_CREATED -> simulated charge -> PAYMENT_COMPLETED | PAYMENT_FAILED.
 * Runs inside the Reliable Event Processor transaction (ctx.session): the payment update, the
 * result event (outbox) and the "event COMPLETED" record commit together.
 */
import { EVENT_TYPES } from '../events/eventTypes.js';
import { createChildEvent } from '../events/eventFactory.js';
import { addToOutbox } from '../outbox/outboxService.js';
import { CONSUMER_NAMES } from '../messaging/topology.js';
import { PermanentError } from '../reliable-event-processor/errors.js';
import { chargeOrderPayment } from '../services/payment.service.js';

async function onOrderCreated(event, { session }) {
  const { orderId, orderNumber } = event.payload;
  const result = await chargeOrderPayment(orderId, event.eventId, session);

  if (result.outcome === 'NOT_FOUND') throw new PermanentError(`No payment operation exists for order ${orderId}`);
  if (result.outcome === 'ALREADY_PROCESSED') return; // business-level guard: never charge twice

  const { payment } = result;
  const succeeded = result.outcome === 'SUCCEEDED';
  await addToOutbox(
    createChildEvent(event, {
      eventType: succeeded ? EVENT_TYPES.PAYMENT_COMPLETED : EVENT_TYPES.PAYMENT_FAILED,
      payload: succeeded
        ? { orderId, orderNumber, paymentReference: payment.paymentReference, amount: payment.amount, gatewayTransactionId: payment.gatewayTransactionId }
        : { orderId, orderNumber, paymentReference: payment.paymentReference, amount: payment.amount, reason: result.reason || 'Declined' },
    }),
    session
  );
}

export const paymentConsumer = {
  name: CONSUMER_NAMES.PAYMENT,
  handlers: { [EVENT_TYPES.ORDER_CREATED]: onOrderCreated },
};
