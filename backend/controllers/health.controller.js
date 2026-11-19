import { getDatabaseStatus } from '../config/database.js';
import { getRedisHealth } from '../config/redis.js';
import { getBrokerStatus } from '../config/rabbitmq.js';

/** GET /api/health — reports service connectivity only (never credentials or config). */
export async function health(req, res) {
  const mongodb = getDatabaseStatus();
  const redis = await getRedisHealth();
  const rabbitmq = { status: getBrokerStatus().status };
  const healthy =
    mongodb.status === 'connected' && mongodb.transactionsSupported && redis.status === 'connected' && rabbitmq.status === 'connected';

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    services: { api: { status: 'up' }, mongodb, redis, rabbitmq },
  });
}
