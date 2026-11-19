/**
 * Unit tests for the Redis idempotency protocol (requires the Redis Docker container).
 * The business handler is a stub, so MongoDB is not needed for this file.
 */
import './helpers/env.js';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectRedis, disconnectRedis, isRedisReady } from '../config/redis.js';
import { executeIdempotent, getIdempotencyRecord, IDEMPOTENCY_STATE } from '../services/idempotency.service.js';
import { AppError } from '../utils/AppError.js';
import { sleep } from '../utils/helpers.js';
import { flushTestKeys } from './helpers/redis.js';

const scope = 'unit.test';
const userId = 'user-1';

function countingHandler({ delayMs = 0, fail } = {}) {
  const handler = async () => {
    handler.calls += 1;
    if (delayMs) await sleep(delayMs);
    if (fail) throw fail;
    return { statusCode: 201, body: { ok: true, call: handler.calls } };
  };
  handler.calls = 0;
  return handler;
}

describe('executeIdempotent (Redis)', () => {
  before(async () => {
    await connectRedis();
    assert.ok(isRedisReady(), 'Redis must be running (docker compose up -d)');
  });
  beforeEach(flushTestKeys);
  after(async () => {
    await flushTestKeys();
    await disconnectRedis();
  });

  test('first request executes, duplicate replays the stored response', async () => {
    const key = randomUUID();
    const handler = countingHandler();
    const first = await executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler });
    const second = await executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler });

    assert.equal(handler.calls, 1);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.body, first.body);
    assert.equal((await getIdempotencyRecord(scope, userId, key)).state, IDEMPOTENCY_STATE.COMPLETED);
  });

  test('concurrent requests with the same key execute the handler exactly once', async () => {
    const key = randomUUID();
    const handler = countingHandler({ delayMs: 300 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler }))
    );
    assert.equal(handler.calls, 1);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      assert.equal(r.reason.code, 'REQUEST_IN_PROGRESS');
      assert.ok(Number(r.reason.headers['Retry-After']) >= 1);
    }
  });

  test('same key with a different payload is rejected with 409', async () => {
    const key = randomUUID();
    await executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler: countingHandler() });
    await assert.rejects(
      executeIdempotent({ scope, userId, key, fingerprint: 'f2', handler: countingHandler() }),
      (err) => err.statusCode === 409 && err.code === 'IDEMPOTENCY_KEY_REUSED'
    );
  });

  test('keys are scoped per user', async () => {
    const key = randomUUID();
    const handler = countingHandler();
    await executeIdempotent({ scope, userId: 'u-a', key, fingerprint: 'f1', handler });
    await executeIdempotent({ scope, userId: 'u-b', key, fingerprint: 'f1', handler });
    assert.equal(handler.calls, 2);
  });

  test('deterministic 4xx failures are stored as FAILED and replayed without re-execution', async () => {
    const key = randomUUID();
    const handler = countingHandler({ fail: new AppError(422, 'INSUFFICIENT_STOCK', 'No stock') });
    await assert.rejects(executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler }));
    const replay = await executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler });
    assert.equal(handler.calls, 1);
    assert.equal(replay.statusCode, 422);
    assert.equal(replay.body.error.code, 'INSUFFICIENT_STOCK');
    assert.equal(replay.state, IDEMPOTENCY_STATE.FAILED);
  });

  test('unexpected 5xx failures release the lock so the client can retry with the same key', async () => {
    const key = randomUUID();
    await assert.rejects(
      executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler: countingHandler({ fail: new Error('db down') }) })
    );
    assert.equal(await getIdempotencyRecord(scope, userId, key), null);
    const handler = countingHandler();
    const retry = await executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler });
    assert.equal(retry.statusCode, 201);
    assert.equal(handler.calls, 1);
  });

  test('an abandoned PROCESSING lock (crashed request) expires and the key becomes usable', async () => {
    const key = randomUUID();
    // Simulate a crash: the first request acquires the lock and never finishes.
    const hung = executeIdempotent({
      scope, userId, key, fingerprint: 'f1', processingTtlMs: 300, handler: () => new Promise(() => {}),
    });
    hung.catch(() => {});
    await sleep(50);
    await assert.rejects(
      executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler: countingHandler() }),
      (err) => err.code === 'REQUEST_IN_PROGRESS'
    );
    await sleep(400); // lock TTL elapsed
    const handler = countingHandler();
    const result = await executeIdempotent({ scope, userId, key, fingerprint: 'f1', handler });
    assert.equal(result.statusCode, 201);
    assert.equal(handler.calls, 1);
  });

  test('durable recovery: if the durable store already has the result, the handler is not run', async () => {
    const key = randomUUID();
    const handler = countingHandler();
    const stored = { statusCode: 201, body: { ok: true, from: 'mongo' } };
    const result = await executeIdempotent({
      scope, userId, key, fingerprint: 'f1', handler, recover: async () => ({ fingerprint: 'f1', response: stored }),
    });
    assert.equal(handler.calls, 0);
    assert.equal(result.replayed, true);
    assert.deepEqual(result.body, stored.body);
  });
});
