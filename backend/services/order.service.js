/**
 * Order Service — all order business logic lives here (controllers stay thin).
 *
 * Stage 2 checkout (ONE MongoDB transaction — everything commits or nothing does):
 *   validate & price items from DB -> check stock availability (no deduction)
 *   -> create order PENDING (unique idempotency key) -> create Payment operation PENDING
 *   -> insert ORDER_CREATED into the outbox -> remove items from cart
 * COMMIT. Nothing is published to RabbitMQ inside the transaction (no dual write):
 * the Outbox Publisher publishes ORDER_CREATED afterwards, and the Payment / Inventory
 * consumers + the order saga (orderSaga.service.js) drive the order to its final status.
 */
import mongoose from 'mongoose';
import { Order, Product, ORDER_STATUS, PAYMENT_STATUS } from '../models/index.js';
import { runInTransaction } from '../config/database.js';
import { AppError } from '../utils/AppError.js';
import { multiplyPrice, sumAmounts, CURRENCY } from '../utils/money.js';
import { paginate } from '../utils/helpers.js';
import { assertAvailable } from './inventory.service.js';
import { buildPaymentReference, createPendingPayment } from './payment.service.js';
import { removePurchasedItems } from './cart.service.js';
import { addToOutbox } from '../outbox/outboxService.js';
import { createEvent } from '../events/eventFactory.js';
import { EVENT_TYPES } from '../events/eventTypes.js';

const IDEMPOTENCY_INDEX = 'uniq_user_idempotency_key';

function isIdempotencyKeyConflict(err) {
  return (
    err?.code === 11000 &&
    (err.keyPattern?.idempotencyKey !== undefined || String(err.message).includes(IDEMPOTENCY_INDEX))
  );
}

/** Human-friendly, display-only order number derived from the (unique) order ID. */
function buildOrderNumber(orderId, date = new Date()) {
  const ymd = date.toISOString().slice(2, 10).replace(/-/g, '');
  return `ORD-${ymd}-${String(orderId).slice(-6).toUpperCase()}`;
}

/**
 * Loads products from MongoDB and builds priced order lines.
 * Client-side prices are never used.
 */
async function priceOrderItems(items, session) {
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) }, isActive: true }).session(session);
  const byId = new Map(products.map((p) => [String(p._id), p]));

  return items.map(({ productId, quantity }) => {
    const product = byId.get(productId);
    if (!product) {
      throw new AppError(422, 'PRODUCT_UNAVAILABLE', 'One or more products are no longer available', {
        details: { productId },
      });
    }
    return {
      productId: product._id,
      name: product.name,
      image: product.image,
      unitPrice: product.price,
      quantity,
      lineTotal: multiplyPrice(product.price, quantity),
    };
  });
}

/**
 * Creates an order atomically.
 * @returns {Promise<{order: object, alreadyExisted: boolean}>}
 *   alreadyExisted=true when a concurrent/earlier request with the same idempotency key
 *   had already committed an order (detected via the unique index).
 */
export async function createOrder({ userId, items, shippingAddress, idempotencyKey, requestFingerprint }) {
  try {
    const orderId = await runInTransaction(async (session) => {
      const orderItems = await priceOrderItems(items, session);
      const totalAmount = sumAmounts(orderItems.map((i) => i.lineTotal));
      const orderId = new mongoose.Types.ObjectId();
      const now = new Date();

      const paymentReference = buildPaymentReference(orderId);

      // 1. Create the order first: the unique (userId, idempotencyKey) index rejects
      //    duplicates before anything else is written.
      await Order.create(
        [
          {
            _id: orderId,
            orderNumber: buildOrderNumber(orderId, now),
            userId,
            orderItems,
            totalAmount,
            currency: CURRENCY,
            shippingAddress,
            orderStatus: ORDER_STATUS.PENDING,
            paymentStatus: PAYMENT_STATUS.PENDING,
            paymentReference,
            idempotencyKey,
            requestFingerprint,
            statusHistory: [{ status: ORDER_STATUS.PENDING, note: 'Order received — awaiting payment and stock reservation', at: now }],
          },
        ],
        { session }
      );

      // 2. Stock availability check (fast feedback at checkout). The actual reservation is
      //    done by the Inventory Consumer with conditional updates, so it can never oversell.
      await assertAvailable(orderItems, session);

      // 3. Payment operation record (PENDING) with its unique reference.
      const payment = await createPendingPayment({ orderId, userId, amount: totalAmount }, session);
      await Order.updateOne({ _id: orderId }, { $set: { paymentId: payment._id } }, { session });

      // 4. ORDER_CREATED event into the transactional outbox (same transaction).
      await addToOutbox(
        createEvent({
          eventType: EVENT_TYPES.ORDER_CREATED,
          aggregateType: 'Order',
          aggregateId: String(orderId),
          correlationId: String(orderId),
          payload: {
            orderId: String(orderId),
            orderNumber: buildOrderNumber(orderId, now),
            userId: String(userId),
            totalAmount,
            currency: CURRENCY,
            paymentReference,
            items: orderItems.map((i) => ({ productId: String(i.productId), quantity: i.quantity, name: i.name })),
          },
        }),
        session
      );

      // 5. Remove purchased items from the cart.
      await removePurchasedItems(userId, orderItems.map((i) => i.productId), session);

      return orderId;
    });

    return { order: (await Order.findById(orderId)).toJSON(), alreadyExisted: false };
  } catch (err) {
    if (isIdempotencyKeyConflict(err)) {
      // Another request with this key already committed. Return that order instead of failing.
      const existing = await findOrderDocumentByIdempotencyKey(userId, idempotencyKey);
      if (existing) return { order: existing.toJSON(), alreadyExisted: true, requestFingerprint: existing.requestFingerprint };
    }
    throw err;
  }
}

async function findOrderDocumentByIdempotencyKey(userId, idempotencyKey) {
  return Order.findOne({ userId, idempotencyKey });
}

/** Durable idempotency lookup used to recover when Redis has no record of the key. */
export async function findOrderByIdempotencyKey(userId, idempotencyKey) {
  const order = await findOrderDocumentByIdempotencyKey(userId, idempotencyKey);
  return order ? { order: order.toJSON(), requestFingerprint: order.requestFingerprint } : null;
}

export async function listUserOrders(userId, { page, limit }) {
  const filter = { userId };
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Order.countDocuments(filter),
  ]);
  return { orders: orders.map((o) => o.toJSON()), pagination: paginate({ page, limit, total }) };
}

/** Customers can only read their own orders; admins can read any order. */
export async function getOrderForUser(orderId, user) {
  const order = await Order.findById(orderId);
  if (!order || (user.role !== 'ADMIN' && String(order.userId) !== user.id)) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  return order.toJSON();
}
