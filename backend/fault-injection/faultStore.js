/**
 * Shared fault configuration, stored in Redis so that the API process (where the admin
 * configures faults) and every worker process (where faults are injected) see the same
 * configuration immediately.
 *
 *   <prefix>:fault:<consumer>:<FAULT_TYPE>  ->  JSON
 *   { faultType, targetConsumer, enabled, failureRate, failureCount, remaining, delayMs, copies,
 *     applyTo, matchedAttempts, injectedCount, createdAt, updatedAt, lastInjectedAt, enabledBy }
 *
 * Faults are OFF by default: a fault exists only after an admin enables it. Disabling keeps the
 * record (enabled=false) so the panel can show what was configured and how often it fired.
 * Fault configuration is completely separate from event-processing status.
 */
import { getRedisClient, isRedisReady, redisKey } from '../config/redis.js';
import { FAULT_TYPE_NAMES, FAULT_TYPES, faultTypesForConsumer } from './faultDefinitions.js';

export const faultKey = (consumer, faultType) => redisKey('fault', consumer, faultType);

// Atomically decides whether THIS attempt is affected and consumes one unit of `remaining`.
// ARGV[1] = random roll 0..99.999 (computed in Node), ARGV[2] = ISO timestamp.
const TRY_TRIGGER = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local f = cjson.decode(raw)
if f.enabled ~= true then return 0 end
f.matchedAttempts = (f.matchedAttempts or 0) + 1
local hit = tonumber(ARGV[1]) < (f.failureRate or 100)
local limited = f.remaining ~= nil and f.remaining ~= cjson.null
if hit and limited and f.remaining <= 0 then hit = false end
if hit then
  if limited then f.remaining = f.remaining - 1 end
  f.injectedCount = (f.injectedCount or 0) + 1
  f.lastInjectedAt = ARGV[2]
end
redis.call('SET', KEYS[1], cjson.encode(f))
if hit then return 1 end
return 0
`;

function parse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Adds derived fields for the UI/API (never stored). */
function present(fault) {
  if (!fault) return null;
  const exhausted = fault.enabled && fault.remaining !== null && fault.remaining !== undefined && fault.remaining <= 0;
  return { ...fault, label: FAULT_TYPES[fault.faultType]?.label ?? fault.faultType, exhausted, active: fault.enabled && !exhausted };
}

export async function saveFault(definition, enabledBy) {
  const redis = getRedisClient();
  const key = faultKey(definition.targetConsumer, definition.faultType);
  const now = new Date().toISOString();
  const previous = parse(await redis.get(key));
  const record = {
    faultType: definition.faultType,
    targetConsumer: definition.targetConsumer,
    enabled: true,
    failureRate: definition.failureRate ?? 100,
    failureCount: definition.failureCount ?? null,
    remaining: definition.failureCount ?? null,
    delayMs: definition.delayMs ?? 0,
    copies: definition.copies ?? 0,
    applyTo: definition.applyTo ?? 'ALL',
    matchedAttempts: 0,
    injectedCount: 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    enabledAt: now,
    lastInjectedAt: null,
    enabledBy,
  };
  await redis.set(key, JSON.stringify(record));
  return present(record);
}

export async function disableFault(faultType, targetConsumer) {
  const redis = getRedisClient();
  const key = faultKey(targetConsumer, faultType);
  const current = parse(await redis.get(key));
  if (!current) return null;
  const updated = { ...current, enabled: false, updatedAt: new Date().toISOString(), disabledAt: new Date().toISOString() };
  await redis.set(key, JSON.stringify(updated));
  return present(updated);
}

/** Disables every fault (returns how many were active). */
export async function disableAllFaults() {
  const faults = await listFaults();
  let count = 0;
  for (const f of faults) {
    if (f.enabled) {
      await disableFault(f.faultType, f.targetConsumer);
      count += 1;
    }
  }
  return count;
}

/** All stored fault records (enabled and disabled). */
export async function listFaults() {
  const redis = getRedisClient();
  const keys = [];
  for (const type of FAULT_TYPE_NAMES) for (const consumer of FAULT_TYPES[type].consumers) keys.push(faultKey(consumer, type));
  const values = await redis.mGet(keys);
  return values.map(parse).filter(Boolean).map(present);
}

/** Enabled faults that can affect `consumer` (used on the hot path; empty if Redis is down). */
export async function getEnabledFaultsForConsumer(consumer) {
  if (!isRedisReady()) return [];
  const types = faultTypesForConsumer(consumer);
  const values = await getRedisClient().mGet(types.map((t) => faultKey(consumer, t)));
  return values.map(parse).filter((f) => f?.enabled);
}

/** Atomically checks failureRate/remaining and records the injection. */
export async function tryTrigger(fault) {
  const result = await getRedisClient().eval(TRY_TRIGGER, {
    keys: [faultKey(fault.targetConsumer, fault.faultType)],
    arguments: [String(Math.random() * 100), new Date().toISOString()],
  });
  return result === 1;
}
