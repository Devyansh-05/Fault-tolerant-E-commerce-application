import { config } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { disconnectRabbitMQ } from './config/rabbitmq.js';
import { initBroker } from './messaging/broker.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';

async function start() {
  // MongoDB is mandatory: without it nothing works, so fail fast with a clear message.
  await connectDatabase();
  // Redis is required for order creation; if it is down we still start and keep retrying.
  await connectRedis();
  // The API does not publish events itself (the Outbox Publisher does); it connects to
  // RabbitMQ for health reporting and queue-depth monitoring. Non-fatal if unavailable:
  // orders are still accepted and their events wait safely in the MongoDB outbox.
  await initBroker();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`API listening on http://localhost:${config.port} (env: ${config.nodeEnv})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully...`);
    server.close(async () => {
      await Promise.allSettled([disconnectRabbitMQ(), disconnectRedis(), disconnectDatabase()]);
      logger.info('Shutdown complete');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  if (/querySrv|ENOTFOUND|ETIMEDOUT|Server selection timed out|IP.*whitelist|not authorized|bad auth/i.test(err.message)) {
    logger.error(
      'Hint: check MONGODB_URI in backend/.env, that the Atlas database user/password are correct, ' +
        'and that your current IP address is allowed under Atlas > Security > Network Access.'
    );
  }
  process.exit(1);
});
