/**
 * Stage 2 — Reliable Event Processing integration tests against REAL infrastructure:
 * MongoDB Atlas (test DB), Redis and RabbitMQ (Docker, isolated "ecommerce_test" exchange/queues).
 * The Outbox Publisher and all four consumers run in this process (startWorker).
 * Failures are induced through the processor's fault hook — the same extension point the
 * Stage 3 Fault Injection Module will use. Outcomes are read from MongoDB / RabbitMQ.
 */
import './helpers/env.js';
import './helpers/eventsEnv.js';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../config/database.js';
import { connectRedis, disconnectRedis } from '../config/redis.js';
import { disconnectRabbitMQ, isBrokerConnected } from '../config/rabbitmq.js';
import { initBroker } from '../messaging/broker.js';
import { startWorker } from '../messaging/worker.js';
import { createConsumerRuntime } from '../consumers/consumerRuntime.js';
import { CONSUMERS } from '../consumers/index.js';
import { mainQueueName } from '../messaging/topology.js';
import { createApp } from '../app.js';
import {
  EventProcessing, Inventory, InventoryReservation, Notification, Order, OutboxEvent, Payment, Product, User, USER_ROLES,
} from '../models/index.js';
import { createOrder } from '../services/order.service.js';
import { hashPassword } from '../services/auth.service.js';
import { signToken } from '../services/token.service.js';
import { setBeforeHandleHook, clearHooks } from '../reliable-event-processor/hooks.js';
import { TransientError } from '../reliable-event-processor/errors.js';
import { BrokerUnavailableError } from '../config/rabbitmq.js';
import { retryPolicy } from '../reliable-event-processor/retryEngine.js';
import { sleep } from '../utils/helpers.js';
import { clearTestDatabase } from './helpers/db.js';
import { flushTestKeys } from './helpers/redis.js';
import { publishRaw, purgeTestQueues, queueDepth, takeFromDlq, waitFor } from './helpers/broker.js';

const shippingAddress = {
  fullName: 'Ravi Kumar', phone: '9876543210', addressLine1: '5 Park Street',
  city: 'Kolkata', state: 'West Bengal', postalCode: '700016', country: 'India',
};

let worker;
let app;
let customer;
let adminToken;
let customerToken;
let phone; // price 1000, stock 100
let tv; // price 60000 (above the test decline limit of 50000), stock 10

// ---- fault rules (consumer-scoped) applied through the processor hook ------------------
let faultRules = [];
const addFault = (rule) => faultRules.push(rule);

// ---- helpers ------------------------------------------------------------------------------
const stock = async (product) => Inventory.findOne({ productId: product.id }).lean();
const record = (eventId, consumerName) => EventProcessing.findOne({ eventId, consumerName }).lean();
const orderCreatedEvent = (orderId) => OutboxEvent.findOne({ aggregateId: String(orderId), eventType: 'ORDER_CREATED' }).lean();

async function place(items) {
  const { order } = await createOrder({
    userId: customer.id,
    items: items.map(([product, quantity]) => ({ productId: product.id, quantity })),
    shippingAddress,
    idempotencyKey: randomUUID(),
    requestFingerprint: 'test',
  });
  return order;
}

const waitForOrder = (orderId, statuses, timeoutMs = 45000) =>
  waitFor(
    async () => {
      const o = await Order.findById(orderId).lean();
      return statuses.includes(o?.orderStatus) ? o : false;
    },
    { timeoutMs, message: `order ${orderId} -> ${statuses.join('|')}` }
  );

const waitForRecord = (eventId, consumerName, predicate, message, timeoutMs = 45000) =>
  waitFor(
    async () => {
      const r = await record(eventId, consumerName);
      return r && predicate(r) ? r : false;
    },
    { timeoutMs, message: `${consumerName} record ${eventId}: ${message}` }
  );

describe('Reliable Event Processing (Atlas + Redis + RabbitMQ)', () => {
  before(async () => {
    await connectDatabase();
    await clearTestDatabase();
    await ensureIndexes();
    await connectRedis();
    await flushTestKeys();
    await initBroker();
    assert.ok(isBrokerConnected(), 'RabbitMQ must be running (docker compose up -d)');
    await purgeTestQueues();

    setBeforeHandleHook(async (ctx) => {
      for (const rule of faultRules) await rule(ctx);
    });

    const make = async (name, price, qty) => {
      const p = await Product.create({ name, price, stock: qty, category: 'Test' });
      await Inventory.create({ productId: p._id, availableQuantity: qty });
      return p.toJSON();
    };
    phone = await make('Event Test Phone', 1000, 100);
    tv = await make('Event Test TV', 60000, 10);
    const user = await User.create({ name: 'Ravi Kumar', email: 'ravi@example.com', passwordHash: await hashPassword('Secret123') });
    customer = user.toJSON();
    customerToken = signToken(user);
    const admin = await User.create({ name: 'Admin', email: 'admin@example.com', role: USER_ROLES.ADMIN, passwordHash: await hashPassword('Secret123') });
    adminToken = signToken(admin);

    app = createApp();
    worker = startWorker();
  });

  beforeEach(() => {
    faultRules = [];
  });

  after(async () => {
    clearHooks();
    try {
      await worker?.stop();
      await purgeTestQueues().catch(() => {});
      await clearTestDatabase();
      await flushTestKeys();
    } finally {
      await disconnectRabbitMQ();
      await disconnectRedis();
      await disconnectDatabase();
    }
  });

  let normalOrder;

  test('TEST 1: normal flow — order -> outbox -> RabbitMQ -> payment + inventory -> saga -> email', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ items: [{ productId: phone.id, quantity: 2 }], shippingAddress });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.order.orderStatus, 'PENDING');
    const orderId = res.body.data.order.id;

    const order = await waitForOrder(orderId, ['CONFIRMED', 'PAYMENT_FAILED', 'INVENTORY_FAILED']);
    assert.equal(order.orderStatus, 'CONFIRMED');
    assert.equal(order.paymentStatus, 'PAID');
    assert.equal(order.fulfillment.payment.status, 'SUCCEEDED');
    assert.equal(order.fulfillment.inventory.status, 'RESERVED');
    normalOrder = order;

    // Outbox: every event of this flow was published.
    const created = await orderCreatedEvent(orderId);
    const types = (await OutboxEvent.find({ correlationId: orderId }).lean()).map((e) => [e.eventType, e.status]);
    for (const t of ['ORDER_CREATED', 'PAYMENT_COMPLETED', 'INVENTORY_RESERVED', 'ORDER_CONFIRMED']) {
      assert.ok(types.some(([type]) => type === t), `missing ${t}`);
    }
    await waitFor(async () => (await OutboxEvent.countDocuments({ correlationId: orderId, status: { $ne: 'PUBLISHED' } })) === 0, { message: 'all published' });

    // Each consumer has its own COMPLETED record for the same ORDER_CREATED event.
    for (const c of ['payment', 'inventory']) {
      const r = await record(created.eventId, c);
      assert.equal(r.status, 'COMPLETED');
      assert.equal(r.attempts, 1);
    }
    const confirmed = await OutboxEvent.findOne({ correlationId: orderId, eventType: 'ORDER_CONFIRMED' }).lean();
    await waitForRecord(confirmed.eventId, 'email', (r) => r.status === 'COMPLETED', 'email completed');

    // Business effects happened exactly once.
    const payment = await Payment.findOne({ orderId }).lean();
    assert.equal(payment.paymentStatus, 'SUCCEEDED');
    assert.equal(payment.processedByEventId, created.eventId);
    const s = await stock(phone);
    assert.equal(s.availableQuantity, 98);
    assert.equal(s.reservedQuantity, 0); // committed on confirmation
    assert.equal((await InventoryReservation.findOne({ orderId }).lean()).status, 'COMMITTED');
    const mails = await Notification.find({ orderId }).lean();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].template, 'ORDER_CONFIRMED');
    assert.equal(mails[0].to, 'ravi@example.com');
  });

  test('TEST 2: duplicate event delivery — same eventId published again has no second effect', async () => {
    const orderId = String(normalOrder._id);
    const created = await orderCreatedEvent(orderId);
    const envelope = {
      eventId: created.eventId, eventType: created.eventType, eventVersion: created.eventVersion, aggregateType: created.aggregateType,
      aggregateId: created.aggregateId, correlationId: created.correlationId, causationId: null,
      createdAt: new Date(created.eventCreatedAt).toISOString(), payload: created.payload,
    };
    await publishRaw('order.created', envelope, { messageId: created.eventId });
    await publishRaw('order.created', envelope, { messageId: created.eventId });

    const confirmed = await OutboxEvent.findOne({ correlationId: orderId, eventType: 'ORDER_CONFIRMED' }).lean();
    await publishRaw('order.confirmed', {
      eventId: confirmed.eventId, eventType: confirmed.eventType, eventVersion: 1, aggregateType: 'Order', aggregateId: orderId,
      correlationId: orderId, causationId: confirmed.causationId, createdAt: new Date(confirmed.eventCreatedAt).toISOString(), payload: confirmed.payload,
    });

    for (const c of ['payment', 'inventory']) {
      const r = await waitForRecord(created.eventId, c, (x) => x.duplicateCount >= 2, 'two duplicates detected');
      assert.equal(r.status, 'COMPLETED');
      assert.equal(r.attempts, 1, `${c} must not execute the handler again`);
      assert.ok(r.history.some((h) => h.status === 'DUPLICATE'));
    }
    await waitForRecord(confirmed.eventId, 'email', (x) => x.duplicateCount >= 1, 'email duplicate detected');

    assert.equal(await Payment.countDocuments({ orderId }), 1);
    assert.equal((await Payment.findOne({ orderId }).lean()).paymentStatus, 'SUCCEEDED');
    assert.equal((await stock(phone)).availableQuantity, 98, 'no second stock deduction');
    assert.equal(await InventoryReservation.countDocuments({ orderId }), 1);
    assert.equal(await Notification.countDocuments({ orderId }), 1, 'no second e-mail');
    assert.equal(await OutboxEvent.countDocuments({ correlationId: orderId, eventType: 'PAYMENT_COMPLETED' }), 1);
  });

  test('TEST 3 + 9: transient payment failure is retried with exponential back-off; consumers keep separate states', async () => {
    let failures = 0;
    let target;
    addFault(async ({ consumerName, event }) => {
      if (consumerName === 'payment' && event.aggregateId === target && failures < 2) {
        failures += 1;
        throw new TransientError(`simulated payment gateway outage #${failures}`);
      }
    });
    const before = (await stock(phone)).availableQuantity;
    const order = await place([[phone, 1]]);
    target = order.id;

    const done = await waitForOrder(order.id, ['CONFIRMED', 'PAYMENT_FAILED', 'INVENTORY_FAILED']);
    assert.equal(done.orderStatus, 'CONFIRMED');
    const created = await orderCreatedEvent(order.id);

    const pay = await record(created.eventId, 'payment');
    assert.equal(pay.status, 'COMPLETED');
    assert.equal(pay.attempts, 3);
    assert.equal(pay.retryCount, 2);
    assert.equal(pay.history.filter((h) => h.status === 'FAILED').length, 2);
    assert.equal(pay.history.filter((h) => h.status === 'RETRYING').length, 2);

    // Exponential back-off: gaps between attempts >= 300 ms, then >= 600 ms.
    const starts = pay.history.filter((h) => h.status === 'PROCESSING').map((h) => new Date(h.at).getTime());
    assert.equal(starts.length, 3);
    const { delaysMs } = retryPolicy();
    assert.deepEqual(delaysMs, [300, 600, 1200]);
    assert.ok(starts[1] - starts[0] >= delaysMs[0] * 0.9, `first gap ${starts[1] - starts[0]} ms`);
    assert.ok(starts[2] - starts[1] >= delaysMs[1] * 0.9, `second gap ${starts[2] - starts[1]} ms`);

    // TEST 9: inventory processed the SAME event independently, first time.
    const inv = await record(created.eventId, 'inventory');
    assert.equal(inv.status, 'COMPLETED');
    assert.equal(inv.attempts, 1);
    assert.equal(inv.retryCount, 0);

    assert.equal(await Payment.countDocuments({ orderId: order.id, paymentStatus: 'SUCCEEDED' }), 1);
    assert.equal((await stock(phone)).availableQuantity, before - 1);
  });

  test('TEST 4: retry exhaustion — email keeps failing -> DLQ after max attempts, payload preserved', async () => {
    let target;
    addFault(async ({ consumerName, event }) => {
      if (consumerName === 'email' && event.aggregateId === target) throw new TransientError('simulated SMTP server unavailable');
    });
    const order = await place([[phone, 1]]);
    target = order.id;
    await waitForOrder(order.id, ['CONFIRMED']);
    const confirmed = await waitFor(() => OutboxEvent.findOne({ correlationId: order.id, eventType: 'ORDER_CONFIRMED' }).lean(), { message: 'ORDER_CONFIRMED' });

    const { maxAttempts } = retryPolicy();
    const r = await waitForRecord(confirmed.eventId, 'email', (x) => x.status === 'DLQ', 'moved to DLQ');
    assert.equal(maxAttempts, 4);
    assert.equal(r.attempts, maxAttempts);
    assert.equal(r.retryCount, maxAttempts - 1);
    assert.equal(r.failureType, 'TRANSIENT');
    assert.match(r.lastError, /Retries exhausted after 4 attempt\(s\): simulated SMTP/);
    assert.equal(r.event.payload.customer.email, 'ravi@example.com'); // original payload preserved in MongoDB

    const dead = await takeFromDlq('email', (m) => m.properties.headers['x-dlq-event-id'] === confirmed.eventId);
    assert.ok(dead, 'message must be in the email DLQ');
    assert.equal(dead.properties.headers['x-dlq-attempts'], 4);
    assert.equal(dead.properties.headers['x-dlq-consumer'], 'email');
    const body = JSON.parse(dead.content.toString());
    assert.equal(body.eventId, confirmed.eventId);
    assert.deepEqual(body.payload, confirmed.payload); // original payload preserved in RabbitMQ

    assert.equal(await Notification.countDocuments({ orderId: order.id }), 0);
    assert.equal((await Order.findById(order.id).lean()).orderStatus, 'CONFIRMED'); // e-mail failure does not undo the order
  });

  test('permanent failures (invalid JSON / invalid schema) skip retries and go straight to the DLQ', async () => {
    await publishRaw('order.created', 'this is not json{');
    await publishRaw('order.created', { eventId: 'bad-event-0001', eventType: 'ORDER_CREATED', payload: {} });

    for (const c of ['payment', 'inventory']) {
      const bad = await waitForRecord('bad-event-0001', c, (x) => x.status === 'DLQ', 'invalid schema dead-lettered');
      assert.equal(bad.failureType, 'PERMANENT');
      assert.equal(bad.attempts, 1);
      assert.equal(bad.retryCount, 0);
      assert.match(bad.lastError, /Invalid event envelope/);
      const garbage = await waitFor(
        () => EventProcessing.findOne({ consumerName: c, eventId: /^invalid-/, lastError: /not valid JSON/ }).lean(),
        { message: `${c} invalid JSON record` }
      );
      assert.equal(garbage.status, 'DLQ');
    }
  });

  test('TEST 5: RabbitMQ unavailable — events stay in the outbox and are published after recovery', async () => {
    await disconnectRabbitMQ(); // the whole process loses its broker connection
    const order = await place([[phone, 1]]);

    const pending = await waitFor(
      async () => {
        const e = await orderCreatedEvent(order.id);
        return e && e.publishAttempts >= 2 && e.status === 'PENDING' ? e : false;
      },
      { message: 'failed publish attempts recorded' }
    );
    assert.match(pending.lastError, /not connected/i);
    assert.equal((await Order.findById(order.id).lean()).orderStatus, 'PENDING'); // order safe in MongoDB

    await initBroker(); // RabbitMQ is back
    const done = await waitForOrder(order.id, ['CONFIRMED']);
    assert.equal(done.orderStatus, 'CONFIRMED');
    const published = await orderCreatedEvent(order.id);
    assert.equal(published.status, 'PUBLISHED');
    assert.ok(published.publishAttempts >= 3);
  });

  test('TEST 6: publisher crash after broker confirm -> event published twice, processed once', async () => {
    let target;
    let crashed = false;
    worker.publisher.hooks.afterConfirm = async (doc) => {
      if (doc.aggregateId === target && doc.eventType === 'ORDER_CREATED' && !crashed) {
        crashed = true;
        throw new Error('simulated publisher crash before marking PUBLISHED');
      }
    };
    try {
      const before = (await stock(phone)).availableQuantity;
      const order = await place([[phone, 1]]);
      target = order.id;
      await waitForOrder(order.id, ['CONFIRMED']);

      const created = await waitFor(async () => {
        const e = await orderCreatedEvent(order.id);
        return e.publishCount >= 2 && e.status === 'PUBLISHED' ? e : false;
      }, { message: 're-published after claim timeout' });
      assert.equal(created.publishCount, 2);

      for (const c of ['payment', 'inventory']) {
        await waitForRecord(created.eventId, c, (x) => x.duplicateCount >= 1 && x.status === 'COMPLETED', 'second copy detected as duplicate');
      }
      assert.equal(await Payment.countDocuments({ orderId: order.id, paymentStatus: 'SUCCEEDED' }), 1);
      assert.equal((await stock(phone)).availableQuantity, before - 1);
      assert.equal(await OutboxEvent.countDocuments({ correlationId: order.id, eventType: 'ORDER_CONFIRMED' }), 1);
    } finally {
      worker.publisher.hooks.afterConfirm = null;
    }
  });

  test('TEST 7: consumer crash mid-processing -> unacked message redelivered, processed once', async () => {
    let target;
    let crashed = false;
    addFault(async ({ consumerName, event }) => {
      if (consumerName === 'inventory' && event.aggregateId === target && !crashed) {
        crashed = true;
        await worker.consumers.inventory.crash(); // channel closes without ack
        await new Promise(() => {}); // the "dead" handler never continues
      }
    });
    const before = (await stock(phone)).availableQuantity;
    const order = await place([[phone, 3]]);
    target = order.id;
    await waitFor(() => crashed, { message: 'inventory consumer crashed' });

    // Restart the inventory consumer (as a supervisor/operator would).
    worker.consumers.inventory = createConsumerRuntime(CONSUMERS.inventory);
    worker.consumers.inventory.start();

    const done = await waitForOrder(order.id, ['CONFIRMED', 'INVENTORY_FAILED'], 60000);
    assert.equal(done.orderStatus, 'CONFIRMED');
    const created = await orderCreatedEvent(order.id);
    const inv = await record(created.eventId, 'inventory');
    assert.equal(inv.status, 'COMPLETED');
    assert.ok(inv.history.some((h) => h.message === 'redelivered by broker' || h.status === 'DEFERRED' || h.status === 'RETRYING'));
    assert.equal(await InventoryReservation.countDocuments({ orderId: order.id }), 1);
    assert.equal((await stock(phone)).availableQuantity, before - 3, 'stock deducted exactly once');
  });

  test('TEST 8: consumers are independent — payment completes while inventory is stopped', async () => {
    await worker.consumers.inventory.stop();
    const order = await place([[phone, 1]]);
    const created = await waitFor(() => orderCreatedEvent(order.id), { message: 'ORDER_CREATED' });
    await waitForRecord(created.eventId, 'payment', (x) => x.status === 'COMPLETED', 'payment completed');

    const processing = await waitForOrder(order.id, ['PROCESSING']);
    assert.equal(processing.fulfillment.payment.status, 'SUCCEEDED');
    assert.equal(processing.fulfillment.inventory.status, 'PENDING');
    assert.equal(await record(created.eventId, 'inventory'), null);
    assert.ok((await queueDepth(mainQueueName('inventory'))) >= 1, 'event waits durably in the inventory queue');

    worker.consumers.inventory = createConsumerRuntime(CONSUMERS.inventory);
    worker.consumers.inventory.start();
    assert.equal((await waitForOrder(order.id, ['CONFIRMED'])).orderStatus, 'CONFIRMED');
  });

  test('saga compensation: inventory fails after payment succeeded -> INVENTORY_FAILED + refund + failure e-mail', async () => {
    await worker.consumers.inventory.stop();
    const order = await place([[phone, 5]]);
    const created = await waitFor(() => orderCreatedEvent(order.id), { message: 'ORDER_CREATED' });
    await waitForRecord(created.eventId, 'payment', (x) => x.status === 'COMPLETED', 'payment completed');
    const before = (await stock(phone)).availableQuantity;
    await Inventory.updateOne({ productId: phone.id }, { $set: { availableQuantity: 2 } }); // stock sold elsewhere meanwhile

    worker.consumers.inventory = createConsumerRuntime(CONSUMERS.inventory);
    worker.consumers.inventory.start();
    const failed = await waitForOrder(order.id, ['INVENTORY_FAILED', 'CONFIRMED']);
    assert.equal(failed.orderStatus, 'INVENTORY_FAILED');
    assert.equal(failed.paymentStatus, 'REFUNDED');
    assert.deepEqual(failed.compensation, { paymentRefunded: true, stockReleased: false });
    assert.equal((await Payment.findOne({ orderId: order.id }).lean()).paymentStatus, 'REFUNDED');
    assert.equal((await stock(phone)).availableQuantity, 2);

    const mail = await waitFor(() => Notification.findOne({ orderId: order.id }).lean(), { message: 'failure e-mail' });
    assert.equal(mail.template, 'ORDER_FAILED');
    assert.match(mail.body, /refunded/);
    await Inventory.updateOne({ productId: phone.id }, { $set: { availableQuantity: before } });
  });

  test('saga compensation: payment declined after stock reserved -> PAYMENT_FAILED + stock released', async () => {
    const before = (await stock(tv)).availableQuantity;
    const order = await place([[tv, 1]]); // 60000 > decline limit 50000
    const failed = await waitForOrder(order.id, ['PAYMENT_FAILED', 'CONFIRMED', 'INVENTORY_FAILED']);
    assert.equal(failed.orderStatus, 'PAYMENT_FAILED');
    assert.equal(failed.paymentStatus, 'FAILED');
    assert.equal((await Payment.findOne({ orderId: order.id }).lean()).paymentStatus, 'FAILED');
    // Inventory may have reserved before or after the payment result; either way stock ends unchanged.
    await waitFor(async () => (await stock(tv)).availableQuantity === before, { message: 'stock restored' });
    const s = await stock(tv);
    assert.equal(s.reservedQuantity, 0);
    const reservation = await InventoryReservation.findOne({ orderId: order.id }).lean();
    assert.equal(reservation.status, 'RELEASED');
    assert.equal(failed.compensation.stockReleased, true);
  });

  test('consumer timeout (slow dependency) is a transient failure and is retried', async () => {
    let target;
    let slowed = false;
    addFault(async ({ consumerName, event }) => {
      if (consumerName === 'payment' && event.aggregateId === target && !slowed) {
        slowed = true;
        await sleep(8600); // longer than EVENT_PROCESSING_TIMEOUT_MS (8000)
      }
    });
    const order = await place([[phone, 1]]);
    target = order.id;
    const done = await waitForOrder(order.id, ['CONFIRMED'], 60000);
    assert.equal(done.orderStatus, 'CONFIRMED');
    const created = await orderCreatedEvent(order.id);
    const pay = await record(created.eventId, 'payment');
    assert.equal(pay.attempts, 2);
    assert.ok(pay.history.some((h) => h.status === 'FAILED' && /timed out/.test(h.message)));
    assert.equal(await Payment.countDocuments({ orderId: order.id, paymentStatus: 'SUCCEEDED' }), 1);
  });

  test('Redis unavailable — MongoDB durable records still prevent duplicate business effects', async () => {
    await disconnectRedis();
    try {
      const order = await place([[phone, 1]]);
      await waitForOrder(order.id, ['CONFIRMED']);
      const created = await orderCreatedEvent(order.id);
      const envelope = {
        eventId: created.eventId, eventType: 'ORDER_CREATED', eventVersion: 1, aggregateType: 'Order', aggregateId: order.id,
        correlationId: order.id, causationId: null, createdAt: new Date(created.eventCreatedAt).toISOString(), payload: created.payload,
      };
      const before = (await stock(phone)).availableQuantity;
      await publishRaw('order.created', envelope);
      await waitForRecord(created.eventId, 'payment', (x) => x.duplicateCount >= 1, 'duplicate detected without Redis');
      await waitForRecord(created.eventId, 'inventory', (x) => x.duplicateCount >= 1, 'duplicate detected without Redis');
      assert.equal(await Payment.countDocuments({ orderId: order.id, paymentStatus: 'SUCCEEDED' }), 1);
      assert.equal((await stock(phone)).availableQuantity, before);
    } finally {
      await connectRedis();
    }
  });

  test('monitoring API returns real statistics (admin only)', async () => {
    await sleep(500);
    const auth = { Authorization: `Bearer ${adminToken}` };
    assert.equal((await request(app).get('/api/events/stats').set('Authorization', `Bearer ${customerToken}`)).status, 403);

    const stats = await request(app).get('/api/events/stats').set(auth);
    assert.equal(stats.status, 200);
    const s = stats.body.data;
    assert.equal(s.processingRecords, await EventProcessing.countDocuments());
    assert.equal(s.inDlq, await EventProcessing.countDocuments({ status: 'DLQ' }));
    assert.equal(s.successful, await EventProcessing.countDocuments({ status: 'COMPLETED' }));
    assert.ok(s.duplicateDeliveries >= 5);
    assert.ok(s.retried >= 2);
    assert.ok(s.outbox.publishedMoreThanOnce >= 1);

    const list = await request(app).get('/api/events?status=DLQ&limit=50').set(auth);
    assert.equal(list.body.data.pagination.total, s.inDlq);

    const consumers = await request(app).get('/api/events/consumer-stats').set(auth);
    assert.deepEqual(consumers.body.data.consumers.map((c) => c.consumer).sort(), ['email', 'inventory', 'order', 'payment']);

    const dlq = await request(app).get('/api/events/dlq?consumer=email').set(auth);
    assert.ok(dlq.body.data.records.every((r) => r.status === 'DLQ' && r.consumerName === 'email' && r.event));

    const created = await orderCreatedEvent(String(normalOrder._id));
    const detail = await request(app).get(`/api/events/${created.eventId}`).set(auth);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.data.consumers.map((c) => c.consumerName).sort(), ['inventory', 'payment']);
    assert.ok(detail.body.data.childEvents.some((e) => e.eventType === 'PAYMENT_COMPLETED'));

    const cfg = await request(app).get('/api/events/config').set(auth);
    assert.equal(cfg.body.data.retry.maxAttempts, 4);
  });
});
