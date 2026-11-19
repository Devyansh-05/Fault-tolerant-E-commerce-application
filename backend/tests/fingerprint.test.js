import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, computeFingerprint } from '../utils/fingerprint.js';
import { createOrderSchema } from '../validators/order.validators.js';
import { multiplyPrice, sumAmounts } from '../utils/money.js';

const address = {
  fullName: 'Test User', phone: '9876543210', addressLine1: '1 Main Road',
  city: 'Delhi', state: 'Delhi', postalCode: '110001', country: 'India',
};
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

test('canonicalJson ignores object key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test('fingerprint is identical for semantically identical order payloads', () => {
  const p1 = createOrderSchema.parse({ items: [{ productId: A, quantity: 1 }, { productId: B, quantity: 2 }], shippingAddress: address });
  const p2 = createOrderSchema.parse({
    shippingAddress: { ...address, fullName: '  Test User  ' },
    items: [{ quantity: 2, productId: B.toUpperCase() }, { productId: A, quantity: 1, price: 1 }], // reordered, extra field
  });
  assert.equal(computeFingerprint(p1), computeFingerprint(p2));
});

test('fingerprint changes when the payload changes', () => {
  const p1 = createOrderSchema.parse({ items: [{ productId: A, quantity: 1 }], shippingAddress: address });
  const p2 = createOrderSchema.parse({ items: [{ productId: A, quantity: 2 }], shippingAddress: address });
  assert.notEqual(computeFingerprint(p1), computeFingerprint(p2));
});

test('order schema rejects duplicate products and non-integer quantities', () => {
  assert.equal(createOrderSchema.safeParse({ items: [{ productId: A, quantity: 1 }, { productId: A, quantity: 1 }], shippingAddress: address }).success, false);
  assert.equal(createOrderSchema.safeParse({ items: [{ productId: A, quantity: 1.5 }], shippingAddress: address }).success, false);
});

test('money helpers avoid floating-point drift', () => {
  assert.equal(multiplyPrice(19.99, 3), 59.97);
  assert.equal(sumAmounts([0.1, 0.2]), 0.3);
});
