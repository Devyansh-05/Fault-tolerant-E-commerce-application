/**
 * Synthetic Event Generator (Stage 3).
 *
 * Creates synthetic test events and sends them through the REAL pipeline:
 *   MongoDB transaction (outbox) -> Outbox Publisher -> RabbitMQ -> consumers ->
 *   Reliable Event Processor (idempotency, retry, DLQ, status tracking).
 * Nothing is marked as processed here; statuses appear only when consumers process events.
 *
 * Isolation from real customer data:
 *   - a dedicated synthetic customer (isSynthetic, cannot log in)
 *   - 20 dedicated synthetic products (hidden from the catalogue, own inventory records), spread
 *     round-robin to avoid write contention on one inventory document
 *   - orders/payments flagged isTest + testBatchId, excluded from business statistics
 *   - every event carries metadata { isTestEvent: true, testBatchId, source: 'generator' }
 * Real products' stock is never touched and no real payment is involved.
 */
import mongoose from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { runInTransaction } from '../config/database.js';
import {
  EventProcessing, Inventory, InventoryReservation, Notification, Order, ORDER_STATUS, OutboxEvent, Payment,
  PAYMENT_RECORD_STATUS, PAYMENT_STATUS, Product, User, USER_ROLES,
} from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { createEvent } from '../events/eventFactory.js';
import { EVENT_TYPES } from '../events/eventTypes.js';
import { addToOutbox } from '../outbox/outboxService.js';
import { GENERATED_EVENT_TYPES } from '../validators/testing.validators.js';
import { hashPassword } from './auth.service.js';
import { buildPaymentReference } from './payment.service.js';
import { CURRENCY } from '../utils/money.js';
import { logger } from '../utils/logger.js';

export const SYNTHETIC_CUSTOMER_EMAIL = 'synthetic.customer@shopsphere.test';
const SYNTHETIC_PRODUCT_COUNT = 20;
const SYNTHETIC_PRICE = 499;
const SYNTHETIC_MIN_STOCK = 10000;
const CHUNK_SIZE = 50; // events per MongoDB transaction

let cachedFixtures = null;

async function ensureFixtures() {
  if (!cachedFixtures) {
    let user = await User.findOne({ email: SYNTHETIC_CUSTOMER_EMAIL });
    if (!user) {
      try {
        user = await User.create({
          name: 'Synthetic Test Customer',
          email: SYNTHETIC_CUSTOMER_EMAIL,
          passwordHash: await hashPassword(randomUUID()), // random: nobody can log in as this user
          role: USER_ROLES.CUSTOMER,
          isSynthetic: true,
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        user = await User.findOne({ email: SYNTHETIC_CUSTOMER_EMAIL });
      }
    }
    const products = [];
    for (let i = 1; i <= SYNTHETIC_PRODUCT_COUNT; i += 1) {
      const slug = `synthetic-test-product-${i}`;
      await Product.updateOne(
        { slug },
        {
          $setOnInsert: {
            name: `Synthetic Test Product ${i}`,
            slug,
            description: 'Synthetic product used only by the reliability test-event generator.',
            price: SYNTHETIC_PRICE,
            category: 'Synthetic',
            stock: SYNTHETIC_MIN_STOCK,
            isActive: false, // never shown in the catalogue
          },
        },
        { upsert: true }
      );
      products.push(await Product.findOne({ slug }).lean());
    }
    cachedFixtures = { user, products };
  }
  // Keep plenty of synthetic stock (never touches real products).
  await Inventory.bulkWrite(
    cachedFixtures.products.map((p) => ({
      updateOne: {
        filter: { productId: p._id },
        update: { $max: { availableQuantity: SYNTHETIC_MIN_STOCK }, $setOnInsert: { reservedQuantity: 0 } },
        upsert: true,
      },
    }))
  );
  return cachedFixtures;
}

const newBatchId = () => {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `TEST-${ts}-${randomBytes(2).toString('hex').toUpperCase()}`;
};

function buildTestOrder({ index, batchId, metadata, fixtures, now }) {
  const product = fixtures.products[index % fixtures.products.length];
  const orderId = new mongoose.Types.ObjectId();
  const paymentId = new mongoose.Types.ObjectId();
  const orderNumber = `${batchId}-${String(index + 1).padStart(3, '0')}`;
  const paymentReference = buildPaymentReference(orderId);
  const item = { productId: product._id, name: product.name, image: '', unitPrice: SYNTHETIC_PRICE, quantity: 1, lineTotal: SYNTHETIC_PRICE };

  return {
    order: {
      _id: orderId,
      orderNumber,
      userId: fixtures.user._id,
      orderItems: [item],
      totalAmount: SYNTHETIC_PRICE,
      currency: CURRENCY,
      shippingAddress: {
        fullName: 'Synthetic Test Customer', phone: '0000000000', addressLine1: 'Synthetic test data',
        city: 'Test City', state: 'Test State', postalCode: '000000', country: 'Test',
      },
      orderStatus: ORDER_STATUS.PENDING,
      paymentStatus: PAYMENT_STATUS.PENDING,
      paymentId,
      paymentReference,
      idempotencyKey: `synthetic-${batchId}-${index}`,
      requestFingerprint: 'synthetic-test-event',
      statusHistory: [{ status: ORDER_STATUS.PENDING, note: `Synthetic test order (batch ${batchId})`, at: now }],
      isTest: true,
      testBatchId: batchId,
    },
    payment: {
      _id: paymentId,
      orderId,
      userId: fixtures.user._id,
      amount: SYNTHETIC_PRICE,
      currency: CURRENCY,
      paymentReference,
      method: 'SIMULATED',
      paymentStatus: PAYMENT_RECORD_STATUS.PENDING,
      isTest: true,
    },
    event: createEvent({
      eventType: EVENT_TYPES.ORDER_CREATED,
      aggregateType: 'Order',
      aggregateId: String(orderId),
      correlationId: String(orderId),
      metadata,
      payload: {
        orderId: String(orderId),
        orderNumber,
        userId: String(fixtures.user._id),
        totalAmount: SYNTHETIC_PRICE,
        currency: CURRENCY,
        paymentReference,
        items: [{ productId: String(product._id), quantity: 1, name: product.name }],
      },
    }),
  };
}

function buildTestEmail({ index, count, batchId, metadata }) {
  const aggregateId = `${batchId}-${index + 1}`;
  return createEvent({
    eventType: EVENT_TYPES.EMAIL_NOTIFICATION_REQUESTED,
    aggregateType: 'Notification',
    aggregateId,
    correlationId: batchId,
    metadata,
    payload: {
      to: SYNTHETIC_CUSTOMER_EMAIL,
      subject: `Synthetic test e-mail ${index + 1}/${count} (${batchId})`,
      body: 'This is a synthetic notification generated by the reliability test panel.',
      template: 'SYNTHETIC_TEST',
    },
  });
}

/**
 * Deletes synthetic test data so a demonstration can start from zero. Only documents marked
 * as test data are touched (real orders, events and stock are never deleted). Refuses while
 * test events are still being published or processed, to avoid orphaned in-flight messages.
 * Messages already sitting in RabbitMQ DLQ queues are not removed (purge them in the
 * Management UI if needed).
 */
export async function resetTestData(requestedBy) {
  const [inFlightOutbox, inFlightRecords] = await Promise.all([
    OutboxEvent.countDocuments({ isTestEvent: true, status: { $ne: 'PUBLISHED' } }),
    EventProcessing.countDocuments({ isTestEvent: true, status: { $in: ['RECEIVED', 'PROCESSING', 'RETRYING', 'FAILED'] } }),
  ]);
  if (inFlightOutbox + inFlightRecords > 0) {
    throw new AppError(409, 'TEST_EVENTS_IN_FLIGHT', `${inFlightOutbox + inFlightRecords} test event(s) are still in flight; wait until they finish`);
  }
  const testOrders = await Order.find({ isTest: true }, { _id: 1 }).lean();
  const orderIds = testOrders.map((o) => o._id);
  const [records, outbox, orders, payments, reservations, notifications] = await Promise.all([
    EventProcessing.deleteMany({ isTestEvent: true }),
    OutboxEvent.deleteMany({ isTestEvent: true }),
    Order.deleteMany({ isTest: true }),
    Payment.deleteMany({ isTest: true }),
    InventoryReservation.deleteMany({ orderId: { $in: orderIds } }),
    Notification.deleteMany({ $or: [{ orderId: { $in: orderIds } }, { to: SYNTHETIC_CUSTOMER_EMAIL }] }),
  ]);
  const deleted = {
    processingRecords: records.deletedCount,
    outboxEvents: outbox.deletedCount,
    orders: orders.deletedCount,
    payments: payments.deletedCount,
    reservations: reservations.deletedCount,
    notifications: notifications.deletedCount,
  };
  logger.warn(`[generator] synthetic test data reset by ${requestedBy}: ${JSON.stringify(deleted)}`);
  return { deleted };
}

/**
 * @returns {{batchId, eventType, requested, accepted, failed, generatedAt, errors}}
 *   accepted = events durably stored in the outbox (NOT "processed").
 */
export async function generateTestEvents({ count, eventType }, requestedBy) {
  const batchId = newBatchId();
  const metadata = { isTestEvent: true, testBatchId: batchId, source: 'generator' };
  const fixtures = eventType === GENERATED_EVENT_TYPES.TEST_ORDER_EVENT ? await ensureFixtures() : null;

  let accepted = 0;
  let failed = 0;
  const errors = [];

  for (let start = 0; start < count; start += CHUNK_SIZE) {
    const size = Math.min(CHUNK_SIZE, count - start);
    try {
      await runInTransaction(async (session) => {
        const now = new Date();
        if (eventType === GENERATED_EVENT_TYPES.TEST_ORDER_EVENT) {
          const built = Array.from({ length: size }, (_, i) => buildTestOrder({ index: start + i, batchId, metadata, fixtures, now }));
          await Order.insertMany(built.map((b) => b.order), { session });
          await Payment.insertMany(built.map((b) => b.payment), { session });
          await addToOutbox(built.map((b) => b.event), session, { source: 'generator' });
        } else {
          const events = Array.from({ length: size }, (_, i) => buildTestEmail({ index: start + i, count, batchId, metadata }));
          await addToOutbox(events, session, { source: 'generator' });
        }
      });
      accepted += size;
    } catch (err) {
      failed += size;
      errors.push(err.message);
      logger.error(`[generator] chunk ${start}-${start + size - 1} of ${batchId} failed: ${err.message}`);
    }
  }

  logger.info(`[generator] ${requestedBy} generated ${accepted}/${count} ${eventType} event(s), batch ${batchId}`);
  return {
    batchId,
    eventType,
    requested: count,
    accepted,
    failed,
    generatedAt: new Date().toISOString(),
    errors: errors.slice(0, 3),
    note: 'Accepted = committed to the outbox. Processing outcomes appear on the Reliability Dashboard as consumers handle them.',
  };
}
