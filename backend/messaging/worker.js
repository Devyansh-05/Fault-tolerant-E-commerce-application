/**
 * Starts the asynchronous side of the system in the current process:
 *   - the Outbox Publisher ("publisher")
 *   - any of the consumers ("payment", "inventory", "order", "email")
 * Used by worker.js (CLI) and by the integration tests.
 */
import { CONSUMERS } from '../consumers/index.js';
import { createConsumerRuntime } from '../consumers/consumerRuntime.js';
import { createOutboxPublisher } from '../outbox/outboxPublisher.js';
import { logger } from '../utils/logger.js';

export const WORKER_COMPONENTS = Object.freeze(['publisher', ...Object.keys(CONSUMERS)]);

export function startWorker({ components = WORKER_COMPONENTS, publisherOptions, prefetch } = {}) {
  const unknown = components.filter((c) => !WORKER_COMPONENTS.includes(c));
  if (unknown.length) throw new Error(`Unknown worker component(s): ${unknown.join(', ')}. Valid: ${WORKER_COMPONENTS.join(', ')}`);

  const publisher = components.includes('publisher') ? createOutboxPublisher(publisherOptions) : null;
  const consumers = Object.fromEntries(
    components.filter((c) => c !== 'publisher').map((name) => [name, createConsumerRuntime(CONSUMERS[name], { prefetch })])
  );

  publisher?.start();
  Object.values(consumers).forEach((c) => c.start());
  logger.info(`Worker started: ${components.join(', ')}`);

  return {
    publisher,
    consumers,
    async stop() {
      await Promise.all(Object.values(consumers).map((c) => c.stop()));
      await publisher?.stop();
    },
  };
}
