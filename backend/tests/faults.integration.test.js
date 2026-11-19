/**
 * Stage 3 — Fault Injection, Synthetic Event Generator, monitoring and DLQ replay.
 * Real infrastructure (Atlas test DB, Redis, RabbitMQ test namespace). Everything is driven
 * through the HTTP API exactly like the Admin Testing Panel does; faults are stored in Redis
 * and injected by the real faultInjector hooks inside the worker pipeline.
 */
import './helpers/env.js';
import './helpers/eventsEnv.js';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../config/database.js';
import { connectRedis, disconnectRedis } from '../config/redis.js';
import { disconnectRabbitMQ } from '../config/rabbitmq.js';
import { initBroker } from '../messaging/broker.js';
import { startWorker } from '../messaging/worker.js';
import { installFaultInjection } from '../fault-injection/faultInjector.js';
import { clearHooks } from '../reliable-event-processor/hooks.js';
import { createApp } from '../app.js';
import {
  EventProcessing, Inventory, InventoryReservation, Notification, Order, OutboxEvent, Payment, Product, User, USER_ROLES,
} from '../models/index.js';
import { hashPassword } from '../services/auth.service.js';
import { signToken } from '../services/token.service.js';
import { clearTestDatabase } from './helpers/db.js';
import { flushTestKeys } from './helpers/redis.js';
import { purgeTestQueues, waitFor } from './helpers/broker.js';

let app;
let worker;
let admin;
let customer;
let realProduct;

const as = (token) => ({ Authorization: `Bearer ${token}` });
const api = {
  get: (path, token = admin) => request(app).get(path).set(as(token)),
  post: (path, body, token = admin) => request(app).post(path).set(as(token)).send(body),
};
const enable = (body) => api.post('/api/admin/faults/enable', body);
const generate = async (count, eventType = 'TEST_ORDER_EVENT') => {
  const res = await api.post('/api/admin/testing/generate-events', { count, eventType });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const records = (filter) => EventProcessing.find(filter).lean();
const createdEvents = (batchId) => OutboxEvent.find({ testBatchId: batchId, eventType: 'ORDER_CREATED' }).lean();

async function waitForBatchOrders(batchId, count, statuses = ['CONFIRMED'], timeoutMs = 60000) {
  return waitFor(
    async () => {
      const orders = await Order.find({ testBatchId: batchId }).lean();
      return orders.length === count && orders.every((o) => statuses.includes(o.orderStatus)) ? orders : false;
    },
    { timeoutMs, message: `${count} order(s) of ${batchId} -> ${statuses.join('|')}` }
  );
}

const waitForRecord = (filter, predicate, message, timeoutMs = 60000) =>
  waitFor(
    async () => {
      const r = await EventProcessing.findOne(filter).lean();
      return r && predicate(r) ? r : false;
    },
    { timeoutMs, message }
  );

describe('Stage 3: fault injection, generator, dashboard data, DLQ replay', () => {
  before(async () => {
    await connectDatabase();
    await clearTestDatabase();
    await ensureIndexes();
    await connectRedis();
    await flushTestKeys();
    await initBroker();
    await purgeTestQueues();

    const adminUser = await User.create({ name: 'Admin', email: 'admin@stage3.test', role: USER_ROLES.ADMIN, passwordHash: await hashPassword('Secret123') });
    const customerUser = await User.create({ name: 'Customer', email: 'customer@stage3.test', passwordHash: await hashPassword('Secret123') });
    admin = signToken(adminUser);
    customer = signToken(customerUser);
    const p = await Product.create({ name: 'Real Product', price: 100, stock: 50, category: 'Real' });
    await Inventory.create({ productId: p._id, availableQuantity: 50 });
    realProduct = p.toJSON();

    assert.equal(installFaultInjection(), true);
    app = createApp();
    worker = startWorker();
  });

  beforeEach(async () => {
    await api.post('/api/admin/faults/disable', { all: true });
    // Faults apply to the NEXT matching attempts, whatever event they belong to. Start each
    // scenario only when the previous one is fully processed (e.g. its e-mails), so a fault
    // cannot be consumed by a leftover event of an earlier test.
    await sleepUntilIdle();
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

  test('TEST 11: admin authorization — customers and anonymous users are rejected by the backend', async () => {
    const endpoints = [
      ['get', '/api/admin/faults'],
      ['post', '/api/admin/faults/enable', { faultType: 'PAYMENT_FAILURE', targetConsumer: 'payment' }],
      ['post', '/api/admin/faults/disable', { all: true }],
      ['post', '/api/admin/testing/generate-events', { count: 1 }],
      ['post', '/api/admin/testing/duplicate-delivery', { eventId: 'abcdefgh-1234' }],
      ['get', '/api/events'],
      ['get', '/api/events/stats'],
      ['get', '/api/events/consumer-stats'],
      ['get', '/api/events/dlq'],
      ['post', '/api/events/dlq/abcdefgh-1234/replay', { consumer: 'payment' }],
    ];
    for (const [method, path, body] of endpoints) {
      const anon = await request(app)[method](path).send(body);
      assert.equal(anon.status, 401, `${method} ${path} anonymous`);
      const cust = await request(app)[method](path).set(as(customer)).send(body);
      assert.equal(cust.status, 403, `${method} ${path} customer`);
    }
    const res = await api.get('/api/admin/faults');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.available, true);
    assert.equal(res.body.data.activeCount, 0, 'faults are disabled by default');
    assert.equal(res.body.data.definitions.length, 6);
  });

  test('fault configuration is validated against allowlists and limits', async () => {
    const bad = [
      { faultType: 'NOT_A_FAULT', targetConsumer: 'payment' },
      { faultType: 'PAYMENT_FAILURE', targetConsumer: 'inventory' },
      { faultType: 'PAYMENT_FAILURE', targetConsumer: 'payment', failureRate: 150 },
      { faultType: 'PAYMENT_FAILURE', targetConsumer: 'payment', failureCount: -1 },
      { faultType: 'ARTIFICIAL_DELAY', targetConsumer: 'email' },
      { faultType: 'ARTIFICIAL_DELAY', targetConsumer: 'email', delayMs: 999999 },
      { faultType: 'DUPLICATE_DELIVERY', targetConsumer: 'payment', copies: 50 },
      { faultType: 'PERSISTENT_FAILURE', targetConsumer: 'nobody' },
    ];
    for (const body of bad) assert.equal((await enable(body)).status, 400, JSON.stringify(body));
    for (const count of [0, -5, 100000, 'ten']) {
      assert.equal((await api.post('/api/admin/testing/generate-events', { count })).status, 400, `count ${count}`);
    }
    // Irrelevant parameters are dropped (persistent failure always uses 100 %).
    const ok = await enable({ faultType: 'PERSISTENT_FAILURE', targetConsumer: 'email', failureRate: 10, delayMs: 5000, failureCount: 2 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.fault.failureRate, 100);
    assert.equal(ok.body.data.fault.delayMs, 0);
    const disabled = await api.post('/api/admin/faults/disable', { faultType: 'PERSISTENT_FAILURE', targetConsumer: 'email' });
    assert.equal(disabled.body.data.fault.enabled, false);
  });

  let normalBatch;

  test('TEST 1: normal processing — 10 synthetic orders flow through outbox, RabbitMQ and all consumers', async () => {
    const realStockBefore = (await Inventory.findOne({ productId: realProduct.id }).lean()).availableQuantity;
    const result = await generate(10);
    assert.equal(result.requested, 10);
    assert.equal(result.accepted, 10);
    assert.equal(result.failed, 0);
    assert.match(result.batchId, /^TEST-/);
    normalBatch = result.batchId;

    // Accepted is not completed: right after generation nothing is processed yet.
    const orders = await waitForBatchOrders(normalBatch, 10);
    assert.ok(orders.every((o) => o.isTest && o.paymentStatus === 'PAID'));

    await waitFor(async () => (await records({ testBatchId: normalBatch, consumerName: 'email', status: 'COMPLETED' })).length === 10, { message: 'emails' });
    const all = await records({ testBatchId: normalBatch });
    assert.equal(all.length, 50); // 10 payment + 10 inventory + 20 order + 10 email
    assert.ok(all.every((r) => r.status === 'COMPLETED' && r.attempts === 1 && r.isTestEvent === true));

    const stats = (await api.get(`/api/events/stats?scope=test&batchId=${normalBatch}`)).body.data;
    assert.equal(stats.logicalEvents, 40); // ORDER_CREATED, PAYMENT_COMPLETED, INVENTORY_RESERVED, ORDER_CONFIRMED x10
    assert.equal(stats.processingRecords, 50);
    assert.equal(stats.successful, 50);
    assert.equal(stats.retried, 0);
    assert.equal(stats.failedAttempts, 0);
    assert.equal(stats.inDlq, 0);

    // Isolation: real stock untouched, test orders excluded from business numbers.
    assert.equal((await Inventory.findOne({ productId: realProduct.id }).lean()).availableQuantity, realStockBefore);
    const overview = (await api.get('/api/admin/overview')).body.data;
    assert.equal(overview.totalOrders, 0);
    assert.equal(overview.syntheticTestOrders, 10);
    assert.equal(await Notification.countDocuments({ orderId: { $in: orders.map((o) => o._id) } }), 10);
  });

  test('synthetic e-mail events exercise the email consumer only', async () => {
    const { batchId } = await generate(5, 'TEST_EMAIL_EVENT');
    await waitFor(async () => (await records({ testBatchId: batchId, status: 'COMPLETED' })).length === 5, { message: '5 emails' });
    const rs = await records({ testBatchId: batchId });
    assert.ok(rs.every((r) => r.consumerName === 'email' && r.eventType === 'EMAIL_NOTIFICATION_REQUESTED'));
    assert.equal(await Notification.countDocuments({ eventId: { $in: rs.map((r) => r.eventId) } }), 5);
  });

  test('TEST 4: temporary payment failure (next 2 attempts) -> retries -> completes', async () => {
    assert.equal((await enable({ faultType: 'PAYMENT_FAILURE', targetConsumer: 'payment', failureRate: 100, failureCount: 2, applyTo: 'TEST_EVENTS' })).status, 200);
    const { batchId } = await generate(1);
    const [order] = await waitForBatchOrders(batchId, 1);
    const [created] = await createdEvents(batchId);
    const pay = await EventProcessing.findOne({ eventId: created.eventId, consumerName: 'payment' }).lean();
    assert.equal(pay.status, 'COMPLETED');
    assert.equal(pay.attempts, 3); // attempt 1 + 2 retries
    assert.equal(pay.failedAttempts, 2);
    assert.equal(pay.retryCount, 2);
    assert.ok(pay.history.filter((h) => h.status === 'FAILED').every((h) => /\[FAULT INJECTION\] Simulated payment gateway failure/.test(h.message)));
    assert.equal(await Payment.countDocuments({ orderId: order._id, paymentStatus: 'SUCCEEDED' }), 1);

    const fault = (await api.get('/api/admin/faults')).body.data.faults.find((f) => f.faultType === 'PAYMENT_FAILURE');
    assert.equal(fault.injectedCount, 2);
    assert.equal(fault.remaining, 0);
    assert.equal(fault.exhausted, true);
  });

  let dlqEventId;
  let dlqOrderId;

  test('TEST 5 + 10: persistent payment failure -> DLQ after 4 attempts; inventory works independently', async () => {
    await enable({ faultType: 'PERSISTENT_FAILURE', targetConsumer: 'payment', applyTo: 'TEST_EVENTS' });
    const { batchId } = await generate(1);
    const [created] = await waitFor(() => createdEvents(batchId).then((e) => e.length && e), { message: 'event' });
    dlqEventId = created.eventId;
    dlqOrderId = created.aggregateId;

    const pay = await waitForRecord({ eventId: dlqEventId, consumerName: 'payment' }, (r) => r.status === 'DLQ', 'payment DLQ');
    assert.equal(pay.attempts, 4);
    assert.equal(pay.retryCount, 3);
    assert.equal(pay.failedAttempts, 4);
    assert.match(pay.lastError, /Retries exhausted after 4 attempt\(s\)/);
    assert.ok(pay.dlqAt);

    // TEST 10: the inventory consumer processed the same event successfully.
    const inv = await waitForRecord({ eventId: dlqEventId, consumerName: 'inventory' }, (r) => r.status === 'COMPLETED', 'inventory done');
    assert.equal(inv.attempts, 1);
    const order = await Order.findById(dlqOrderId).lean();
    assert.equal(order.orderStatus, 'PROCESSING'); // waits for payment — never confirmed without it
    assert.equal(order.fulfillment.payment.status, 'PENDING');
    assert.equal(order.fulfillment.inventory.status, 'RESERVED');
    assert.equal(await Notification.countDocuments({ orderId: order._id }), 0); // no premature confirmation e-mail

    const dlq = (await api.get('/api/events/dlq?consumer=payment&scope=test')).body.data;
    const entry = dlq.records.find((r) => r.eventId === dlqEventId);
    assert.ok(entry);
    assert.equal(entry.attempts, 4);
    assert.equal(entry.event.payload.orderId, dlqOrderId);
    assert.ok(dlq.queues.find((q) => q.consumer === 'payment').messages >= 1);
  });

  test('DLQ replay (admin) after disabling the fault: completes once, history preserved', async () => {
    await api.post('/api/admin/faults/disable', { all: true });
    const res = await api.post(`/api/events/dlq/${dlqEventId}/replay`, { consumer: 'payment' });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'RETRYING'); // not marked successful before it really is

    const pay = await waitForRecord({ eventId: dlqEventId, consumerName: 'payment' }, (r) => r.status === 'COMPLETED', 'replayed payment');
    assert.equal(pay.replayCount, 1);
    assert.equal(pay.dlqHistory.length, 1);
    assert.equal(pay.dlqHistory[0].attempts, 4);
    assert.match(pay.dlqHistory[0].lastError, /Retries exhausted/);
    assert.ok(pay.history.some((h) => h.status === 'REPLAYED'));

    const order = await waitFor(async () => {
      const o = await Order.findById(dlqOrderId).lean();
      return o.orderStatus === 'CONFIRMED' ? o : false;
    }, { message: 'order confirmed after replay' });
    assert.equal(order.paymentStatus, 'PAID');
    assert.equal(await Payment.countDocuments({ orderId: dlqOrderId, paymentStatus: 'SUCCEEDED' }), 1);

    assert.equal((await api.post(`/api/events/dlq/${dlqEventId}/replay`, { consumer: 'payment' })).status, 409);
    assert.equal((await api.post('/api/events/dlq/unknown-event-id/replay', { consumer: 'payment' })).status, 404);
  });

  test('TEST 6: inventory failure (next attempt) -> retry -> stock reserved exactly once', async () => {
    await enable({ faultType: 'INVENTORY_FAILURE', targetConsumer: 'inventory', failureCount: 1, applyTo: 'TEST_EVENTS' });
    const { batchId } = await generate(1);
    const [order] = await waitForBatchOrders(batchId, 1);
    const [created] = await createdEvents(batchId);
    const inv = await EventProcessing.findOne({ eventId: created.eventId, consumerName: 'inventory' }).lean();
    assert.equal(inv.attempts, 2);
    assert.equal(inv.failedAttempts, 1);
    assert.match(inv.history.find((h) => h.status === 'FAILED').message, /Simulated inventory service failure/);
    assert.equal(await InventoryReservation.countDocuments({ orderId: order._id }), 1);
    assert.equal((await InventoryReservation.findOne({ orderId: order._id }).lean()).status, 'COMMITTED');
  });

  test('TEST 7: email failure (2 attempts) -> retries -> exactly one notification', async () => {
    await enable({ faultType: 'EMAIL_FAILURE', targetConsumer: 'email', failureCount: 2, applyTo: 'TEST_EVENTS' });
    const { batchId } = await generate(1);
    const [order] = await waitForBatchOrders(batchId, 1);
    const mail = await waitForRecord({ testBatchId: batchId, consumerName: 'email' }, (r) => r.status === 'COMPLETED', 'email completed');
    assert.equal(mail.attempts, 3);
    assert.equal(mail.failedAttempts, 2);
    assert.equal(await Notification.countDocuments({ orderId: order._id }), 1);
  });

  test('TEST 8: artificial delay longer than the timeout -> timeout failure -> retry, business effect once', async () => {
    await enable({ faultType: 'ARTIFICIAL_DELAY', targetConsumer: 'inventory', delayMs: 8500, failureCount: 1, applyTo: 'TEST_EVENTS' });
    const { batchId } = await generate(1);
    const [order] = await waitForBatchOrders(batchId, 1, ['CONFIRMED'], 90000);
    const [created] = await createdEvents(batchId);
    const inv = await EventProcessing.findOne({ eventId: created.eventId, consumerName: 'inventory' }).lean();
    assert.equal(inv.attempts, 2);
    assert.ok(inv.history.some((h) => h.status === 'FAILED' && /timed out after 8000 ms/.test(h.message)));
    assert.equal(await InventoryReservation.countDocuments({ orderId: order._id }), 1);
    const reservation = await InventoryReservation.findOne({ orderId: order._id }).lean();
    const stock = await Inventory.findOne({ productId: reservation.items[0].productId }).lean();
    assert.ok(stock.availableQuantity < 10000 && stock.reservedQuantity >= 0);
  });

  test('TEST 3a: DUPLICATE_DELIVERY fault re-delivers the same eventId; no second payment', async () => {
    await enable({ faultType: 'DUPLICATE_DELIVERY', targetConsumer: 'payment', copies: 2, failureCount: 1, applyTo: 'TEST_EVENTS' });
    const { batchId } = await generate(1);
    const [order] = await waitForBatchOrders(batchId, 1);
    const [created] = await createdEvents(batchId);
    const pay = await waitForRecord({ eventId: created.eventId, consumerName: 'payment' }, (r) => r.duplicateCount >= 2, 'two duplicates');
    assert.equal(pay.attempts, 1);
    assert.equal(pay.deliveries, 3);
    assert.equal(await Payment.countDocuments({ orderId: order._id }), 1);
    assert.equal(await OutboxEvent.countDocuments({ correlationId: String(order._id), eventType: 'PAYMENT_COMPLETED' }), 1);
  });

  test('TEST 3b: re-deliver an existing event on demand (same eventId) -> duplicates detected', async () => {
    const [created] = await createdEvents(normalBatch);
    const stockDoc = await InventoryReservation.findOne({ orderId: created.aggregateId }).lean();
    const before = (await Inventory.findOne({ productId: stockDoc.items[0].productId }).lean()).availableQuantity;

    const res = await api.post('/api/admin/testing/duplicate-delivery', { eventId: created.eventId, copies: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.deliveredTo.sort(), ['inventory', 'payment']);

    for (const c of ['payment', 'inventory']) {
      const r = await waitForRecord({ eventId: created.eventId, consumerName: c }, (x) => x.duplicateCount >= 2, `${c} duplicates`);
      assert.equal(r.attempts, 1);
      assert.ok(r.history.some((h) => h.status === 'DUPLICATE'));
    }
    assert.equal(await Payment.countDocuments({ orderId: created.aggregateId }), 1);
    assert.equal(await InventoryReservation.countDocuments({ orderId: created.aggregateId }), 1);
    assert.equal((await Inventory.findOne({ productId: stockDoc.items[0].productId }).lean()).availableQuantity, before);

    assert.equal((await api.post('/api/admin/testing/duplicate-delivery', { eventId: created.eventId, consumer: 'email' })).status, 400);
    assert.equal((await api.post('/api/admin/testing/duplicate-delivery', { eventId: 'no-such-event-123' })).status, 404);
  });

  test('TEST 12: recovery after disabling a fault — pending retries succeed, new events are normal', async () => {
    await enable({ faultType: 'PERSISTENT_FAILURE', targetConsumer: 'email', applyTo: 'TEST_EVENTS' });
    const { batchId } = await generate(2, 'TEST_EMAIL_EVENT');
    await waitFor(async () => (await records({ testBatchId: batchId, failedAttempts: { $gte: 1 } })).length === 2, { message: 'both failed once' });
    await api.post('/api/admin/faults/disable', { faultType: 'PERSISTENT_FAILURE', targetConsumer: 'email' });

    await waitFor(async () => (await records({ testBatchId: batchId, status: 'COMPLETED' })).length === 2, { message: 'both recovered' });
    const rs = await records({ testBatchId: batchId });
    assert.ok(rs.every((r) => r.failedAttempts >= 1 && r.retryCount >= 1 && r.status === 'COMPLETED'));

    const fresh = await generate(2, 'TEST_EMAIL_EVENT');
    await waitFor(async () => (await records({ testBatchId: fresh.batchId, status: 'COMPLETED' })).length === 2, { message: 'new events' });
    assert.ok((await records({ testBatchId: fresh.batchId })).every((r) => r.attempts === 1));
  });

  test('dashboard APIs: totals equal direct database counts; filters and details work', async () => {
    await sleepUntilIdle();
    const s = (await api.get('/api/events/stats?scope=test')).body.data;
    const filter = { isTestEvent: true };
    assert.equal(s.processingRecords, await EventProcessing.countDocuments(filter));
    assert.equal(s.successful, await EventProcessing.countDocuments({ ...filter, status: 'COMPLETED' }));
    assert.equal(s.inDlq, await EventProcessing.countDocuments({ ...filter, status: 'DLQ' }));
    assert.equal(s.logicalEvents, await OutboxEvent.countDocuments(filter));
    const agg = await EventProcessing.aggregate([{ $match: filter }, { $group: { _id: null, d: { $sum: '$duplicateCount' }, f: { $sum: '$failedAttempts' }, r: { $sum: { $cond: [{ $gt: ['$retryCount', 0] }, 1, 0] } } } }]);
    assert.equal(s.duplicateDeliveries, agg[0].d);
    assert.equal(s.failedAttempts, agg[0].f);
    assert.equal(s.retried, agg[0].r);
    assert.ok(s.duplicateDeliveries >= 4 && s.failedAttempts >= 10 && s.replays === 1);

    const consumers = (await api.get('/api/events/consumer-stats?scope=test')).body.data.consumers;
    const payment = consumers.find((c) => c.consumer === 'payment');
    assert.equal(payment.total, await EventProcessing.countDocuments({ ...filter, consumerName: 'payment' }));

    const list = (await api.get('/api/events?scope=test&consumer=payment&status=COMPLETED&limit=5')).body.data;
    assert.equal(list.records.length, 5);
    assert.ok(list.records.every((r) => r.consumerName === 'payment' && r.isTestEvent && r.event === undefined));
    assert.equal((await api.get('/api/events?status=BOGUS')).status, 400);

    const detail = (await api.get(`/api/events/${dlqEventId}`)).body.data;
    assert.equal(detail.isTestEvent, true);
    assert.ok(detail.testBatchId);
    assert.ok(detail.consumers.find((c) => c.consumerName === 'payment').history.length > 5);
    assert.equal((await api.get('/api/events/does-not-exist-123')).status, 404);
  });

  test('reset-test-data deletes only synthetic data', async () => {
    const realOutbox = await OutboxEvent.create({
      eventId: 'real-event-keep-0001', eventType: 'ORDER_CREATED', routingKey: 'order.created', aggregateType: 'Order',
      aggregateId: 'x', correlationId: 'x', payload: {}, eventCreatedAt: new Date(), status: 'PUBLISHED',
    });
    assert.equal((await request(app).post('/api/admin/testing/reset-test-data').set(as(customer))).status, 403);
    const res = await api.post('/api/admin/testing/reset-test-data');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.deleted.outboxEvents > 0);
    assert.equal(await OutboxEvent.countDocuments({ isTestEvent: true }), 0);
    assert.equal(await EventProcessing.countDocuments({ isTestEvent: true }), 0);
    assert.equal(await Order.countDocuments({ isTest: true }), 0);
    assert.ok(await OutboxEvent.exists({ _id: realOutbox._id }), 'real event kept');
    const s = (await api.get('/api/events/stats?scope=test')).body.data;
    assert.equal(s.logicalEvents, 0);
    assert.equal(s.processingRecords, 0);
  });
});

async function sleepUntilIdle() {
  await waitFor(
    async () => {
      const [busyRecords, unpublished] = await Promise.all([
        EventProcessing.countDocuments({ status: { $in: ['RECEIVED', 'PROCESSING', 'RETRYING', 'FAILED'] } }),
        OutboxEvent.countDocuments({ status: { $ne: 'PUBLISHED' } }),
      ]);
      if (busyRecords + unpublished > 0) return false;
      // Every published event must have been picked up by each consumer that receives it.
      const published = await OutboxEvent.find({}, { eventId: 1, routingKey: 1 }).lean();
      const receivers = { 'order.created': 2, 'payment.completed': 1, 'payment.failed': 1, 'inventory.reserved': 1, 'inventory.failed': 1, 'order.confirmed': 1, 'order.failed': 1, 'email.notification.requested': 1 };
      const expected = published.reduce((n, e) => n + (receivers[e.routingKey] ?? 0), 0);
      return (await EventProcessing.countDocuments({ eventId: { $in: published.map((e) => e.eventId) } })) >= expected;
    },
    { message: 'pipeline idle', timeoutMs: 60000, intervalMs: 300 }
  );
}
