/**
 * Stage 1 API tests (and Stage 2 regression) against the REAL infrastructure:
 *   MongoDB Atlas (database MONGODB_TEST_DB_NAME, emptied before/after) + Redis + RabbitMQ (Docker).
 * No worker runs in this file, so orders stay PENDING with their ORDER_CREATED event in the
 * outbox — exactly the synchronous part of checkout. Asynchronous processing is covered by
 * events.integration.test.js.
 */
import './helpers/env.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { config } from '../config/env.js';
import { connectDatabase, disconnectDatabase, ensureIndexes, isTransactionSupported } from '../config/database.js';
import { connectRedis, disconnectRedis, getRedisClient } from '../config/redis.js';
import { createApp } from '../app.js';
import { Cart, Inventory, Order, OutboxEvent, Payment, Product, User, USER_ROLES } from '../models/index.js';
import { disconnectRabbitMQ } from '../config/rabbitmq.js';
import { initBroker } from '../messaging/broker.js';
import { hashPassword } from '../services/auth.service.js';
import { buildIdempotencyRedisKey } from '../services/idempotency.service.js';
import { ORDER_CREATE_SCOPE } from '../controllers/order.controller.js';
import { flushTestKeys } from './helpers/redis.js';
import { clearTestDatabase } from './helpers/db.js';

let app;
let customerToken;
let customerId;
let adminToken;
let laptop; // price 1000.50, stock 10
let mouse; // price 250, stock 5

const shippingAddress = {
  fullName: 'Asha Verma', phone: '+91 98765 43210', addressLine1: '12 MG Road',
  city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'India',
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const placeOrder = (key, body, token = customerToken) =>
  request(app).post('/api/orders').set(auth(token)).set('Idempotency-Key', key).send(body);
const stockOf = async (product) => (await Inventory.findOne({ productId: product.id })).availableQuantity;

describe('API integration (MongoDB Atlas + Redis)', () => {
  before(async () => {
    assert.match(config.mongo.dbName, /test/i);
    await connectDatabase(); // also creates collections + unique indexes
    await clearTestDatabase();
    await ensureIndexes();
    await connectRedis();
    await flushTestKeys();
    await initBroker();
    app = createApp();

    const make = async (name, price, stock) => {
      const p = await Product.create({ name, price, stock, category: 'Test', description: 'test product' });
      await Inventory.create({ productId: p._id, availableQuantity: stock });
      return p.toJSON();
    };
    laptop = await make('Test Laptop', 1000.5, 10);
    mouse = await make('Test Mouse', 250, 5);

    await User.create({
      name: 'Test Admin', email: 'admin@test.local', role: USER_ROLES.ADMIN, passwordHash: await hashPassword('AdminPass123'),
    });
  });

  after(async () => {
    try {
      await clearTestDatabase();
      await flushTestKeys();
    } finally {
      await disconnectRabbitMQ();
      await disconnectRedis();
      await disconnectDatabase();
    }
  });

  test('TEST 1-3: health check reports MongoDB (with transactions), Redis and RabbitMQ connected', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.services.mongodb.status, 'connected');
    assert.equal(res.body.services.mongodb.transactionsSupported, true);
    assert.equal(res.body.services.redis.status, 'connected');
    assert.equal(res.body.services.rabbitmq.status, 'connected');
    assert.equal(isTransactionSupported(), true);
    assert.doesNotMatch(JSON.stringify(res.body), /mongodb\+srv|password/i);
  });

  test('TEST 4: register, login and profile', async () => {
    const reg = await request(app).post('/api/auth/register')
      .send({ name: 'Asha Verma', email: 'Asha@Example.com', password: 'Secret123' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.data.user.role, 'CUSTOMER');
    assert.equal(reg.body.data.user.passwordHash, undefined);

    const stored = await User.findOne({ email: 'asha@example.com' }).select('+passwordHash');
    assert.notEqual(stored.passwordHash, 'Secret123');
    assert.match(stored.passwordHash, /^\$2[aby]\$/);

    const dup = await request(app).post('/api/auth/register')
      .send({ name: 'Other', email: 'asha@example.com', password: 'Secret123' });
    assert.equal(dup.status, 409);

    const bad = await request(app).post('/api/auth/login').send({ email: 'asha@example.com', password: 'wrong1234' });
    assert.equal(bad.status, 401);

    const login = await request(app).post('/api/auth/login').send({ email: 'asha@example.com', password: 'Secret123' });
    assert.equal(login.status, 200);
    customerToken = login.body.data.token;
    customerId = login.body.data.user.id;

    const me = await request(app).get('/api/auth/me').set(auth(customerToken));
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, 'asha@example.com');

    assert.equal((await request(app).get('/api/auth/me')).status, 401);
    assert.equal((await request(app).get('/api/auth/me').set(auth('garbage'))).status, 401);

    const adminLogin = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: 'AdminPass123' });
    adminToken = adminLogin.body.data.token;
  });

  test('TEST 5: products can be listed, searched, filtered and fetched', async () => {
    const list = await request(app).get('/api/products?limit=1&sort=price_asc');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.products.length, 1);
    assert.equal(list.body.data.products[0].name, 'Test Mouse');
    assert.equal(list.body.data.pagination.total, 2);
    assert.equal(list.body.data.pagination.totalPages, 2);

    const search = await request(app).get('/api/products?q=lapt');
    assert.deepEqual(search.body.data.products.map((p) => p.name), ['Test Laptop']);

    const regexInjection = await request(app).get('/api/products?q=.*');
    assert.equal(regexInjection.body.data.products.length, 0);

    const byCategory = await request(app).get('/api/products?category=test');
    assert.equal(byCategory.body.data.products.length, 2);

    const one = await request(app).get(`/api/products/${laptop.id}`);
    assert.equal(one.body.data.product.price, 1000.5);
    assert.equal((await request(app).get('/api/products/not-an-id')).status, 400);
    assert.equal((await request(app).get(`/api/products/${new mongoose.Types.ObjectId()}`)).status, 404);
  });

  test('admin product APIs are protected by role', async () => {
    const body = { name: 'Admin Created', price: 99.99, category: 'Test', stock: 3 };
    assert.equal((await request(app).post('/api/products').send(body)).status, 401);
    assert.equal((await request(app).post('/api/products').set(auth(customerToken)).send(body)).status, 403);

    const created = await request(app).post('/api/products').set(auth(adminToken)).send(body);
    assert.equal(created.status, 201);
    const id = created.body.data.product.id;
    assert.equal((await Inventory.findOne({ productId: id })).availableQuantity, 3);

    const updated = await request(app).put(`/api/products/${id}`).set(auth(adminToken)).send({ stock: 7, price: 120 });
    assert.equal(updated.body.data.product.stock, 7);
    assert.equal((await Inventory.findOne({ productId: id })).availableQuantity, 7);

    assert.equal((await request(app).post('/api/products').set(auth(adminToken)).send({ ...body, price: 1.234 })).status, 400);
    assert.equal((await request(app).delete(`/api/products/${id}`).set(auth(adminToken))).status, 200);
    assert.equal((await request(app).get(`/api/products/${id}`)).status, 404);
  });

  test('TEST 6: cart add / update / remove with DB prices and stock validation', async () => {
    let res = await request(app).post('/api/cart/add').set(auth(customerToken)).send({ productId: laptop.id, quantity: 2 });
    assert.equal(res.status, 200);
    res = await request(app).post('/api/cart/add').set(auth(customerToken)).send({ productId: mouse.id, quantity: 1 });
    assert.equal(res.body.data.cart.itemCount, 3);
    assert.equal(res.body.data.cart.subtotal, 2251); // 2 x 1000.50 + 250

    const tooMany = await request(app).post('/api/cart/add').set(auth(customerToken)).send({ productId: mouse.id, quantity: 10 });
    assert.equal(tooMany.status, 422);
    assert.equal((await request(app).post('/api/cart/add').set(auth(customerToken)).send({ productId: mouse.id, quantity: 0 })).status, 400);

    res = await request(app).put('/api/cart/update').set(auth(customerToken)).send({ productId: mouse.id, quantity: 3 });
    assert.equal(res.body.data.cart.subtotal, 2751);

    res = await request(app).delete(`/api/cart/remove/${mouse.id}`).set(auth(customerToken));
    assert.equal(res.body.data.cart.items.length, 1);
    res = await request(app).get('/api/cart').set(auth(customerToken));
    assert.equal(res.body.data.cart.items[0].productId, laptop.id);
  });

  let firstOrder;
  const firstKey = randomUUID();
  const firstBody = () => ({ items: [{ productId: laptop.id, quantity: 2 }], shippingAddress });

  test('TEST 7-9: order, payment operation and ORDER_CREATED outbox event are created atomically', async () => {
    const res = await placeOrder(firstKey, { ...firstBody(), totalAmount: 1 }); // client total is ignored
    assert.equal(res.status, 201);
    firstOrder = res.body.data.order;
    assert.equal(firstOrder.totalAmount, 2001);
    // Stage 2: not confirmed merely because it was inserted — payment/inventory run asynchronously.
    assert.equal(firstOrder.orderStatus, 'PENDING');
    assert.equal(firstOrder.paymentStatus, 'PENDING');
    assert.equal(firstOrder.fulfillment.payment.status, 'PENDING');
    assert.equal(firstOrder.fulfillment.inventory.status, 'PENDING');
    assert.equal(firstOrder.paymentReference, `PAY-${firstOrder.id}`);
    assert.equal(firstOrder.requestFingerprint, undefined);

    const stored = await Order.findById(firstOrder.id);
    assert.equal(stored.idempotencyKey, firstKey);
    assert.equal(stored.orderItems[0].unitPrice, 1000.5);
    assert.deepEqual(stored.statusHistory.map((s) => s.status), ['PENDING']);

    // Stock is only checked at checkout; the Inventory Consumer reserves it later.
    assert.equal(await stockOf(laptop), 10);

    const payments = await Payment.find({ orderId: firstOrder.id });
    assert.equal(payments.length, 1);
    assert.equal(payments[0].paymentStatus, 'PENDING');
    assert.equal(payments[0].amount, 2001);

    const outbox = await OutboxEvent.find({ aggregateId: firstOrder.id });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].eventType, 'ORDER_CREATED');
    assert.equal(outbox[0].routingKey, 'order.created');
    assert.equal(outbox[0].status, 'PENDING');
    assert.equal(outbox[0].payload.totalAmount, 2001);
    assert.equal(outbox[0].payload.paymentReference, `PAY-${firstOrder.id}`);

    const cart = await Cart.findOne({ userId: customerId });
    assert.equal(cart.items.length, 0);

    const record = JSON.parse(await getRedisClient().get(buildIdempotencyRedisKey(ORDER_CREATE_SCOPE, customerId, firstKey)));
    assert.equal(record.state, 'COMPLETED');
  });

  test('TEST 10: same Idempotency-Key twice returns the original order and creates nothing new', async () => {
    const res = await placeOrder(firstKey, firstBody());
    assert.equal(res.status, 201);
    assert.equal(res.headers['idempotent-replayed'], 'true');
    assert.equal(res.body.idempotentReplay, true);
    assert.equal(res.body.data.order.id, firstOrder.id);
    assert.equal(await Order.countDocuments({ idempotencyKey: firstKey }), 1);
    assert.equal(await Payment.countDocuments({ orderId: firstOrder.id }), 1);
    assert.equal(await OutboxEvent.countDocuments({ aggregateId: firstOrder.id }), 1); // no second event
  });

  test('TEST 11: concurrent requests with the same key create exactly one order', async () => {
    const key = randomUUID();
    const body = { items: [{ productId: mouse.id, quantity: 1 }], shippingAddress };
    const responses = await Promise.all(Array.from({ length: 8 }, () => placeOrder(key, body)));
    const statuses = responses.map((r) => r.status);

    assert.ok(statuses.every((s) => s === 201 || s === 409), `unexpected statuses ${statuses}`);
    assert.ok(statuses.includes(201));
    const conflicts = responses.filter((r) => r.status === 409);
    assert.ok(conflicts.every((r) => r.body.error.code === 'REQUEST_IN_PROGRESS'));
    const orderIds = new Set(responses.filter((r) => r.status === 201).map((r) => r.body.data.order.id));
    assert.equal(orderIds.size, 1);

    assert.equal(await Order.countDocuments({ idempotencyKey: key }), 1);
    assert.equal(await OutboxEvent.countDocuments({ aggregateId: [...orderIds][0] }), 1);

    // After completion, a client retry gets the stored result.
    const retry = await placeOrder(key, body);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.idempotentReplay, true);
    assert.equal(retry.body.data.order.id, [...orderIds][0]);
  });

  test('TEST 12: reusing a key with a different payload returns 409', async () => {
    const res = await placeOrder(firstKey, { items: [{ productId: laptop.id, quantity: 1 }], shippingAddress });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await Order.countDocuments({ userId: customerId, idempotencyKey: firstKey }), 1);
  });

  test('TEST 13: a new key allows a new legitimate order', async () => {
    const res = await placeOrder(randomUUID(), firstBody());
    assert.equal(res.status, 201);
    assert.notEqual(res.body.data.order.id, firstOrder.id);
    assert.equal(await OutboxEvent.countDocuments({ aggregateId: res.body.data.order.id, eventType: 'ORDER_CREATED' }), 1);
  });

  test('durable backstop: Redis record lost -> MongoDB still prevents a duplicate order', async () => {
    await getRedisClient().del(buildIdempotencyRedisKey(ORDER_CREATE_SCOPE, customerId, firstKey));
    const replay = await placeOrder(firstKey, firstBody());
    assert.equal(replay.status, 201);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.data.order.id, firstOrder.id);
    assert.equal(await Order.countDocuments({ idempotencyKey: firstKey }), 1);

    // Payload mismatch is detected from the stored MongoDB fingerprint too.
    await getRedisClient().del(buildIdempotencyRedisKey(ORDER_CREATE_SCOPE, customerId, firstKey));
    const mismatch = await placeOrder(firstKey, { items: [{ productId: mouse.id, quantity: 1 }], shippingAddress });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('insufficient stock aborts the whole transaction and the failure is replayed', async () => {
    const key = randomUUID();
    const before = { laptop: await stockOf(laptop), mouse: await stockOf(mouse) };
    const body = { items: [{ productId: laptop.id, quantity: 1 }, { productId: mouse.id, quantity: 20 }], shippingAddress };
    const res = await placeOrder(key, body);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');
    assert.equal(await Order.countDocuments({ idempotencyKey: key }), 0);
    assert.equal(await stockOf(laptop), before.laptop); // laptop deduction rolled back
    assert.equal(await stockOf(mouse), before.mouse);

    const replay = await placeOrder(key, body);
    assert.equal(replay.status, 422);
    assert.equal(replay.body.idempotentReplay, true);
  });

  test('order requests are validated (header, payload, auth)', async () => {
    const body = firstBody();
    assert.equal((await request(app).post('/api/orders').set(auth(customerToken)).send(body)).status, 400);
    assert.equal((await placeOrder('short', body)).status, 400);
    assert.equal((await placeOrder(randomUUID(), { items: [], shippingAddress })).status, 400);
    assert.equal((await request(app).post('/api/orders').set('Idempotency-Key', randomUUID()).send(body)).status, 401);
  });

  test('TEST 14 (API side): order history and order details; other users cannot read them', async () => {
    const list = await request(app).get('/api/orders').set(auth(customerToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.orders.length, 3);
    assert.equal(list.body.data.pagination.total, 3);

    const detail = await request(app).get(`/api/orders/${firstOrder.id}`).set(auth(customerToken));
    assert.equal(detail.body.data.order.orderNumber, firstOrder.orderNumber);

    const other = await request(app).post('/api/auth/register').send({ name: 'Other User', email: 'other@example.com', password: 'Secret123' });
    const peek = await request(app).get(`/api/orders/${firstOrder.id}`).set(auth(other.body.data.token));
    assert.equal(peek.status, 404);

    const adminView = await request(app).get(`/api/orders/${firstOrder.id}`).set(auth(adminToken));
    assert.equal(adminView.status, 200);
  });

  test('admin overview requires ADMIN and reports real counts', async () => {
    assert.equal((await request(app).get('/api/admin/overview').set(auth(customerToken))).status, 403);
    const res = await request(app).get('/api/admin/overview').set(auth(adminToken));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalUsers, 3);
    assert.equal(res.body.data.totalProducts, 2);
    assert.equal(res.body.data.totalOrders, 3);
    assert.equal(res.body.data.recentOrders[0].customer.email, 'asha@example.com');
  });
});
