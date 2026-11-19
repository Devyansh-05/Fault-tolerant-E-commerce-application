/**
 * Centralised Redis client (node-redis v4).
 *
 * One shared connection is used by the HTTP idempotency module today and will be
 * reused by event idempotency / fault-injection configuration in later stages.
 *
 * `disableOfflineQueue` makes commands fail immediately while Redis is down instead of
 * queueing silently — callers can then return a clear 503 rather than hanging.
 */
import { createClient } from 'redis';
import { config } from './env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/AppError.js';
import { sleep } from '../utils/helpers.js';

let client = null;
let lastErrorLogAt = 0;

export async function connectRedis({ waitMs = 5000 } = {}) {
  if (client) return client;

  client = createClient({
    socket: {
      host: config.redis.host,
      port: config.redis.port,
      connectTimeout: 5000,
      // Exponential back-off reconnects, capped at 5 seconds. Never gives up.
      reconnectStrategy: (retries) => Math.min(250 * 2 ** Math.min(retries, 5), 5000),
    },
    password: config.redis.password || undefined,
    disableOfflineQueue: true,
  });

  client.on('ready', () => logger.info(`Redis connected (${config.redis.host}:${config.redis.port})`));
  client.on('end', () => logger.warn('Redis connection closed'));
  client.on('error', (err) => {
    // An 'error' listener is mandatory, otherwise node-redis crashes the process.
    if (Date.now() - lastErrorLogAt > 10000) {
      lastErrorLogAt = Date.now();
      logger.warn(`Redis error: ${err.message}`);
    }
  });

  const connecting = client.connect().catch((err) => logger.warn(`Redis connect failed: ${err.message}`));
  await Promise.race([connecting, sleep(waitMs)]);

  if (!client.isReady) {
    logger.warn(
      'Redis is not reachable yet (is the Docker container running?). Retrying in the background; ' +
        'order creation will return 503 until Redis is available.'
    );
  }
  return client;
}

export function isRedisReady() {
  return Boolean(client?.isReady);
}

/** Returns the connected client or throws a 503 AppError if Redis is unavailable. */
export function getRedisClient() {
  if (!client?.isReady) {
    throw new AppError(503, 'REDIS_UNAVAILABLE', 'The idempotency store is temporarily unavailable. Please retry shortly.');
  }
  return client;
}

/** Builds a namespaced key, e.g. redisKey('idem','http','orders',userId,key) -> "ecom:idem:http:orders:...". */
export function redisKey(...parts) {
  return [config.redis.keyPrefix, ...parts].join(':');
}

export async function getRedisHealth() {
  if (!client?.isReady) return { status: 'disconnected' };
  try {
    const pong = await Promise.race([client.ping(), sleep(2000).then(() => 'TIMEOUT')]);
    return { status: pong === 'PONG' ? 'connected' : 'unresponsive' };
  } catch {
    return { status: 'disconnected' };
  }
}

export async function disconnectRedis() {
  if (!client) return;
  const current = client;
  client = null;
  try {
    if (current.isReady) await current.quit();
    else await current.disconnect();
  } catch {
    /* already closed */
  }
}
