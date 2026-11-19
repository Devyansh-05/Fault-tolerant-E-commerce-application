import { config } from '../../config/env.js';
import { getRedisClient } from '../../config/redis.js';

/** Deletes every key under the test prefix (never touches development keys). */
export async function flushTestKeys() {
  const redis = getRedisClient();
  const keys = [];
  for await (const key of redis.scanIterator({ MATCH: `${config.redis.keyPrefix}:*`, COUNT: 200 })) keys.push(key);
  if (keys.length) await redis.del(keys);
}
