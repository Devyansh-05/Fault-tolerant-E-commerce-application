/**
 * Worker entry point (runs on the host, not in Docker).
 *
 *   node worker.js                     -> Outbox Publisher + all consumers
 *   node worker.js publisher           -> only the Outbox Publisher
 *   node worker.js payment             -> only the Payment Consumer
 *   node worker.js inventory email     -> any combination
 *
 * Several workers may run at the same time (e.g. one process per consumer); the outbox claim
 * logic and event idempotency make that safe.
 */
import { config } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { disconnectRabbitMQ } from './config/rabbitmq.js';
import { initBroker } from './messaging/broker.js';
import { startWorker, WORKER_COMPONENTS } from './messaging/worker.js';
import { installFaultInjection } from './fault-injection/faultInjector.js';
import { logger } from './utils/logger.js';

const requested = process.argv.slice(2).map((a) => a.toLowerCase());
const components = requested.length ? requested : WORKER_COMPONENTS;

async function main() {
  await connectDatabase();
  await connectRedis(); // optional fast path — the processor falls back to MongoDB if Redis is down
  await initBroker(); // reconnects in the background if RabbitMQ is down
  // Stage 3: fault injection hooks (reads the shared Redis configuration; never in production).
  installFaultInjection();
  const worker = startWorker({ components });
  logger.info(`Worker running (env: ${config.nodeEnv}). Press Ctrl+C to stop.`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received - finishing in-flight events...`);
    setTimeout(() => process.exit(1), 15000).unref();
    await worker.stop();
    await Promise.allSettled([disconnectRabbitMQ(), disconnectRedis(), disconnectDatabase()]);
    logger.info('Worker stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Worker failed to start: ${err.message}`);
  process.exit(1);
});
