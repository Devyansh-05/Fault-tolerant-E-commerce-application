/**
 * Centralised, validated environment configuration.
 * Every other module reads configuration from here — never from process.env directly.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const nodeEnv = process.env.NODE_ENV || 'development';
const isTest = nodeEnv === 'test';

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        'Copy backend/.env.example to backend/.env and fill in the value.'
    );
  }
  return value.trim();
}

function optional(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function integer(name, fallback) {
  const raw = optional(name, '');
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw) {
    throw new Error(`Environment variable "${name}" must be a non-negative integer (got "${raw}").`);
  }
  return parsed;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long.');
}

const mongoDbName = isTest
  ? optional('MONGODB_TEST_DB_NAME', 'ecommerce_test')
  : optional('MONGODB_DB_NAME', 'ecommerce');

if (isTest && !/test/i.test(mongoDbName)) {
  // Safety net: the test-suite drops its database, so it must never point at real data.
  throw new Error('MONGODB_TEST_DB_NAME must contain the word "test".');
}

export const config = Object.freeze({
  nodeEnv,
  isTest,
  isProduction: nodeEnv === 'production',
  port: integer('PORT', 5000),
  frontendUrls: optional('FRONTEND_URL', 'http://localhost:5173')
    .split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean),

  mongo: Object.freeze({
    uri: required('MONGODB_URI'),
    dbName: mongoDbName,
  }),

  redis: Object.freeze({
    host: optional('REDIS_HOST', '127.0.0.1'),
    port: integer('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD', ''),
    // Every Redis key is namespaced; tests use a separate prefix so they never touch dev data.
    keyPrefix: isTest ? 'ecomtest' : optional('REDIS_KEY_PREFIX', 'ecom'),
  }),

  jwt: Object.freeze({
    secret: jwtSecret,
    expiresIn: optional('JWT_EXPIRES_IN', '1d'),
  }),

  idempotency: Object.freeze({
    // How long a PROCESSING lock lives. If the server crashes mid-request the lock
    // expires after this many seconds and the client can safely retry with the same key.
    processingTtlSeconds: integer('IDEMPOTENCY_PROCESSING_TTL_SECONDS', 60),
    // How long COMPLETED/FAILED results are cached in Redis for fast replay.
    // After expiry, the MongoDB unique index + stored fingerprint still prevent duplicates.
    recordTtlSeconds: integer('IDEMPOTENCY_RECORD_TTL_SECONDS', 86400),
  }),

  rabbitmq: Object.freeze({
    url: optional('RABBITMQ_URL', 'amqp://ecommerce:ecommerce_dev@127.0.0.1:5672'),
    // Tests use their own exchange/queues so a running dev worker never consumes test messages.
    exchange: isTest ? 'ecommerce_test.events' : optional('RABBITMQ_EXCHANGE', 'ecommerce.events'),
    queuePrefix: isTest ? 'ecommerce_test' : optional('RABBITMQ_QUEUE_PREFIX', 'ecommerce'),
    prefetch: integer('RABBITMQ_PREFETCH', 10),
    publishConfirmTimeoutMs: integer('RABBITMQ_CONFIRM_TIMEOUT_MS', 5000),
  }),

  /**
   * Reliable Event Processor.
   * Counting convention: attempt 1 is the first execution; MAX_RETRIES additional attempts
   * follow, so an event is executed at most (1 + MAX_RETRIES) times before going to the DLQ.
   * Delay before retry n (n = 1..MAX_RETRIES) = min(INITIAL * MULTIPLIER^(n-1), MAX).
   */
  events: Object.freeze({
    maxRetries: integer('MAX_RETRIES', 3),
    initialRetryDelayMs: integer('INITIAL_RETRY_DELAY_MS', 1000),
    maxRetryDelayMs: integer('MAX_RETRY_DELAY_MS', 10000),
    backoffMultiplier: Number(optional('RETRY_BACKOFF_MULTIPLIER', '2')),
    processingTimeoutMs: integer('EVENT_PROCESSING_TIMEOUT_MS', 10000),
    // Redis processing lease. Must exceed the processing timeout. If a consumer crashes,
    // the lease expires and a redelivered copy can be processed.
    leaseMs: integer('EVENT_LEASE_MS', 20000),
    // How long COMPLETED markers stay in Redis (MongoDB keeps the durable record forever).
    idempotencyTtlSeconds: integer('EVENT_IDEMPOTENCY_TTL_SECONDS', 7 * 24 * 3600),
  }),

  outbox: Object.freeze({
    pollIntervalMs: integer('OUTBOX_POLL_INTERVAL_MS', 500),
    batchSize: integer('OUTBOX_BATCH_SIZE', 20),
    // A PUBLISHING claim older than this is considered abandoned (publisher crashed) and re-claimed.
    claimTimeoutMs: integer('OUTBOX_CLAIM_TIMEOUT_MS', 15000),
    maxBackoffMs: integer('OUTBOX_MAX_BACKOFF_MS', 10000),
  }),

  payment: Object.freeze({
    // Simulated gateway business rule: amounts above this are declined (PAYMENT_FAILED).
    declineAbove: Number(optional('SIMULATED_PAYMENT_DECLINE_ABOVE', '500000')),
  }),

  /**
   * Stage 3 — Fault Injection Module and Synthetic Event Generator.
   * Always OFF in production (NODE_ENV=production), regardless of FAULT_INJECTION_ENABLED.
   * "Enabled" means the admin tooling is available; every individual fault is still disabled
   * until an administrator turns it on.
   */
  faultInjection: Object.freeze({
    enabled: nodeEnv !== 'production' && optional('FAULT_INJECTION_ENABLED', 'true').toLowerCase() !== 'false',
    maxDelayMs: integer('FAULT_MAX_DELAY_MS', 30000),
    maxFailureCount: integer('FAULT_MAX_FAILURE_COUNT', 100),
    maxDuplicateCopies: integer('FAULT_MAX_DUPLICATE_COPIES', 5),
  }),
  testing: Object.freeze({
    maxGeneratedEvents: integer('TEST_EVENT_MAX_BATCH', 200),
  }),

  // Used only by the seed script to create the initial administrator account.
  admin: Object.freeze({
    name: optional('ADMIN_NAME', 'Administrator'),
    email: optional('ADMIN_EMAIL', ''),
    password: optional('ADMIN_PASSWORD', ''),
  }),
});
