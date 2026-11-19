/**
 * Event idempotency — Redis fast path (NOT the HTTP request idempotency of Stage 1).
 *
 * Key: <prefix>:idem:event:<consumer>:<eventId>     (scoped per consumer: the same event is
 *                                                    processed independently by each consumer)
 * Value (JSON):
 *   { status: "PROCESSING", consumer, owner, at }   lease, PX = EVENT_LEASE_MS
 *   { status: "COMPLETED",  consumer, at }          EX = EVENT_IDEMPOTENCY_TTL_SECONDS
 *
 * - SET NX PX gives an atomic lease: concurrent deliveries of the same event cannot both run.
 * - A lease left behind by a crashed consumer simply EXPIRES; it is never treated as completed.
 * - Redis is an optimisation, not the guarantee. If Redis is unavailable the processor
 *   continues and the MongoDB record (unique eventId+consumer, completion written in the SAME
 *   transaction as the business effect) still prevents duplicate business effects.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { isRedisReady, getRedisClient, redisKey } from '../config/redis.js';
import { logger } from '../utils/logger.js';

export const LEASE_STATE = Object.freeze({ PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED' });

const RELEASE_IF_OWNER = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if ok and record.owner == ARGV[1] and record.status == 'PROCESSING' then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const eventIdempotencyKey = (consumerName, eventId) => redisKey('idem', 'event', consumerName, eventId);

function warnUnavailable(action, err) {
  logger.warn(`Event idempotency (Redis) unavailable during ${action}: ${err?.message ?? 'not connected'} - falling back to MongoDB guard`);
}

/**
 * Tries to take the processing lease.
 * @returns {Promise<{redisAvailable:boolean, acquired:boolean, state:string|null, owner:string|null}>}
 */
export async function acquireLease(consumerName, eventId, leaseMs = config.events.leaseMs) {
  if (!isRedisReady()) {
    warnUnavailable('acquireLease');
    return { redisAvailable: false, acquired: false, state: null, owner: null };
  }
  const key = eventIdempotencyKey(consumerName, eventId);
  const owner = randomUUID();
  try {
    const redis = getRedisClient();
    const value = JSON.stringify({ status: LEASE_STATE.PROCESSING, consumer: consumerName, owner, at: Date.now() });
    const result = await redis.set(key, value, { NX: true, PX: leaseMs });
    if (result === 'OK') return { redisAvailable: true, acquired: true, state: LEASE_STATE.PROCESSING, owner };

    const raw = await redis.get(key);
    if (!raw) {
      // Expired between SET and GET: try once more.
      const retry = await redis.set(key, value, { NX: true, PX: leaseMs });
      return { redisAvailable: true, acquired: retry === 'OK', state: retry === 'OK' ? LEASE_STATE.PROCESSING : null, owner: retry === 'OK' ? owner : null };
    }
    const record = JSON.parse(raw);
    return { redisAvailable: true, acquired: false, state: record.status ?? null, owner: null };
  } catch (err) {
    warnUnavailable('acquireLease', err);
    return { redisAvailable: false, acquired: false, state: null, owner: null };
  }
}

/** Records completion in Redis (best effort; MongoDB already holds the durable truth). */
export async function markCompleted(consumerName, eventId) {
  if (!isRedisReady()) return false;
  try {
    await getRedisClient().set(
      eventIdempotencyKey(consumerName, eventId),
      JSON.stringify({ status: LEASE_STATE.COMPLETED, consumer: consumerName, at: Date.now() }),
      { EX: config.events.idempotencyTtlSeconds }
    );
    return true;
  } catch (err) {
    warnUnavailable('markCompleted', err);
    return false;
  }
}

/** Releases our lease (only if we still own it) so that a retry can acquire it. */
export async function releaseLease(consumerName, eventId, owner) {
  if (!owner || !isRedisReady()) return;
  try {
    await getRedisClient().eval(RELEASE_IF_OWNER, { keys: [eventIdempotencyKey(consumerName, eventId)], arguments: [owner] });
  } catch (err) {
    warnUnavailable('releaseLease', err);
  }
}

/** Current Redis state for an event/consumer (diagnostics, dashboard). */
export async function getLeaseState(consumerName, eventId) {
  if (!isRedisReady()) return null;
  try {
    const raw = await getRedisClient().get(eventIdempotencyKey(consumerName, eventId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Clears the Redis marker (used by the Stage 3 DLQ replay). */
export async function clearIdempotencyMarker(consumerName, eventId) {
  if (!isRedisReady()) return;
  try {
    await getRedisClient().del(eventIdempotencyKey(consumerName, eventId));
  } catch {
    /* best effort */
  }
}
