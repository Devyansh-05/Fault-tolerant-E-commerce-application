/**
 * HTTP request idempotency backed by Redis, with MongoDB as the durable backstop.
 *
 * Redis record (JSON string) at  <prefix>:idem:http:<scope>:<userId>:<idempotencyKey>
 *   { state: PROCESSING | COMPLETED | FAILED, fingerprint, ownerToken, startedAt,
 *     completedAt?, response?: { statusCode, body } }
 *
 * Algorithm
 *  1. SET key PROCESSING NX PX <processingTtl>  — atomic; only ONE concurrent request wins.
 *  2. Loser requests read the record:
 *       fingerprint differs            -> 409 IDEMPOTENCY_KEY_REUSED
 *       COMPLETED / FAILED             -> replay the stored response (no re-execution)
 *       PROCESSING                     -> 409 REQUEST_IN_PROGRESS (+ Retry-After)
 *  3. The winner first asks the durable store (`recover`) whether this key was already
 *     committed — this covers Redis data loss, expired records and a crash after commit.
 *  4. Otherwise it runs `handler`. Only after the handler returns (i.e. after the MongoDB
 *     transaction has COMMITTED) is the record switched to COMPLETED.
 *  5. Deterministic business failures (4xx) are stored as FAILED and replayed.
 *     Unexpected/transient failures (5xx) delete the lock so the client may retry.
 *
 * Crash safety: if the process dies while PROCESSING, the lock expires after
 * <processingTtl>. A retry then re-acquires it, and step 3 (plus the unique index on
 * orders.userId+idempotencyKey) guarantees the order is never created twice.
 *
 * Redis alone does not give exactly-once execution; Redis + the MongoDB unique
 * constraint together do.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { getRedisClient, redisKey } from '../config/redis.js';
import { AppError, toErrorBody } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

export const IDEMPOTENCY_STATE = Object.freeze({
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

// Atomically overwrite the record only if we still own the lock (or it has expired).
// Prevents a slow request whose lock expired from clobbering a newer owner's record.
const FINALIZE_IF_OWNER = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, record = pcall(cjson.decode, current)
  if (not ok) or record.ownerToken ~= ARGV[1] then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

// Atomically delete the lock only if we still own it.
const RELEASE_IF_OWNER = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if ok and record.ownerToken == ARGV[1] and record.state == 'PROCESSING' then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// Errors that describe the idempotency protocol itself must never be cached as a result.
const NON_CACHEABLE_CODES = new Set(['IDEMPOTENCY_KEY_REUSED', 'REQUEST_IN_PROGRESS', 'REDIS_UNAVAILABLE']);

export function buildIdempotencyRedisKey(scope, userId, key) {
  return redisKey('idem', 'http', scope, userId, key);
}

function keyReusedError() {
  return new AppError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used with a different request payload. Use a new key for a new request.'
  );
}

function inProgressError(retryAfterSeconds) {
  return new AppError(
    409,
    'REQUEST_IN_PROGRESS',
    'A request with this Idempotency-Key is still being processed. Retry shortly with the same key.',
    { headers: { 'Retry-After': String(Math.max(1, retryAfterSeconds)) } }
  );
}

async function readRecord(redis, key) {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn(`Corrupt idempotency record at ${key}; treating as absent`);
    return null;
  }
}

async function finalize(redis, key, ownerToken, record, ttlMs) {
  try {
    const written = await redis.eval(FINALIZE_IF_OWNER, {
      keys: [key],
      arguments: [ownerToken, JSON.stringify({ ...record, ownerToken }), String(ttlMs)],
    });
    if (written !== 1) logger.warn(`Idempotency record ${key} is owned by another request; not overwritten`);
  } catch (err) {
    // The business operation already committed; MongoDB still protects against duplicates
    // even if we could not cache the result in Redis.
    logger.warn(`Could not store idempotency result for ${key}: ${err.message}`);
  }
}

async function release(redis, key, ownerToken) {
  try {
    await redis.eval(RELEASE_IF_OWNER, { keys: [key], arguments: [ownerToken] });
  } catch (err) {
    logger.warn(`Could not release idempotency lock ${key}: ${err.message} (it will expire automatically)`);
  }
}

/**
 * Executes `handler` at most once per (scope, userId, key).
 *
 * @param {object}   params
 * @param {string}   params.scope        Operation namespace, e.g. "orders.create"
 * @param {string}   params.userId       Keys are scoped per user
 * @param {string}   params.key          Client-supplied Idempotency-Key
 * @param {string}   params.fingerprint  Hash of the normalised request payload
 * @param {() => Promise<{statusCode:number, body:object, replayed?:boolean}>} params.handler
 * @param {() => Promise<{fingerprint:string, response:{statusCode:number, body:object}} | null>} [params.recover]
 *        Looks the key up in the durable store (MongoDB).
 * @param {number}  [params.processingTtlMs]  Override (used by tests)
 * @param {number}  [params.recordTtlMs]      Override (used by tests)
 * @returns {Promise<{statusCode:number, body:object, replayed:boolean, state:string}>}
 */
export async function executeIdempotent({
  scope,
  userId,
  key,
  fingerprint,
  handler,
  recover,
  processingTtlMs = config.idempotency.processingTtlSeconds * 1000,
  recordTtlMs = config.idempotency.recordTtlSeconds * 1000,
}) {
  const redis = getRedisClient();
  const recordKey = buildIdempotencyRedisKey(scope, userId, key);
  const ownerToken = randomUUID();

  // --- Step 1/2: try to acquire the lock; otherwise inspect the existing record -------
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
    const processingRecord = {
      state: IDEMPOTENCY_STATE.PROCESSING,
      fingerprint,
      ownerToken,
      startedAt: Date.now(),
    };
    const setResult = await redis.set(recordKey, JSON.stringify(processingRecord), { NX: true, PX: processingTtlMs });
    if (setResult === 'OK') {
      acquired = true;
      break;
    }

    const existing = await readRecord(redis, recordKey);
    if (!existing) continue; // expired between SET and GET — try to acquire again

    if (existing.fingerprint !== fingerprint) throw keyReusedError();

    if (existing.state === IDEMPOTENCY_STATE.COMPLETED || existing.state === IDEMPOTENCY_STATE.FAILED) {
      return { ...existing.response, replayed: true, state: existing.state };
    }

    const ttl = await redis.pTTL(recordKey);
    throw inProgressError(Math.ceil((ttl > 0 ? ttl : processingTtlMs) / 1000));
  }
  if (!acquired) throw inProgressError(1);

  // --- Step 3/4: we own the lock --------------------------------------------------------
  let restoredFromDurable = false;
  try {
    const durable = recover ? await recover() : null;
    if (durable) {
      restoredFromDurable = true;
      // Restore the Redis record from the durable copy (with the ORIGINAL fingerprint).
      await finalize(
        redis,
        recordKey,
        ownerToken,
        { state: IDEMPOTENCY_STATE.COMPLETED, fingerprint: durable.fingerprint, response: durable.response, completedAt: Date.now() },
        recordTtlMs
      );
      if (durable.fingerprint !== fingerprint) throw keyReusedError();
      return { ...durable.response, replayed: true, state: IDEMPOTENCY_STATE.COMPLETED };
    }

    const { replayed = false, ...response } = await handler();

    // The handler has returned => the database transaction has committed. Only now COMPLETED.
    await finalize(
      redis,
      recordKey,
      ownerToken,
      { state: IDEMPOTENCY_STATE.COMPLETED, fingerprint, response, completedAt: Date.now() },
      recordTtlMs
    );
    return { ...response, replayed, state: IDEMPOTENCY_STATE.COMPLETED };
  } catch (err) {
    const isDeterministicFailure =
      err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500 && !NON_CACHEABLE_CODES.has(err.code);

    if (isDeterministicFailure) {
      await finalize(
        redis,
        recordKey,
        ownerToken,
        {
          state: IDEMPOTENCY_STATE.FAILED,
          fingerprint,
          response: { statusCode: err.statusCode, body: toErrorBody(err) },
          completedAt: Date.now(),
        },
        recordTtlMs
      );
    } else if (!restoredFromDurable) {
      // Transient/unexpected failure (or a protocol conflict): nothing new was committed by
      // this request, so free the lock. Durable duplicates are still caught by `recover`.
      await release(redis, recordKey, ownerToken);
    }
    throw err;
  }
}

/** Reads the current Redis record (used by tests and diagnostics). */
export async function getIdempotencyRecord(scope, userId, key) {
  return readRecord(getRedisClient(), buildIdempotencyRedisKey(scope, userId, key));
}
