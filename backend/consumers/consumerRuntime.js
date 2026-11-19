/**
 * Runs one consumer on its own RabbitMQ channel and hands every delivery to the Reliable
 * Event Processor. Handles:
 *  - manual acknowledgements (the processor decides ack/nack)
 *  - per-consumer prefetch (bounded concurrency)
 *  - re-subscription after a channel error or a full broker reconnect
 *  - graceful stop (cancel, wait for in-flight deliveries) and an abrupt crash() used by tests
 *    and the Stage 3 demo to simulate a consumer dying mid-processing
 */
import { config } from '../config/env.js';
import { getConnection, onBrokerReady } from '../config/rabbitmq.js';
import { mainQueueName } from '../messaging/topology.js';
import { processDelivery } from '../reliable-event-processor/eventProcessor.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

export function createConsumerRuntime(definition, { prefetch = config.rabbitmq.prefetch } = {}) {
  const queue = mainQueueName(definition.name);
  const inFlight = new Set();
  let channel = null;
  let stopped = true;
  let unsubscribeReady = null;
  let generation = 0;

  async function subscribe(connection) {
    if (stopped || !connection) return;
    const myGeneration = ++generation;
    if (channel) {
      try {
        await channel.close();
      } catch {
        /* ignore */
      }
    }
    const ch = await connection.createChannel();
    channel = ch;
    ch.on('error', (err) => logger.warn(`[${definition.name}] channel error: ${err.message}`));
    ch.on('close', () => {
      if (channel === ch) channel = null;
      // Channel died but the connection is alive (e.g. channel-level error): resubscribe.
      // A full connection loss is handled by onBrokerReady after the reconnect.
      if (!stopped && myGeneration === generation) {
        setTimeout(() => {
          const conn = getConnection();
          if (!stopped && myGeneration === generation && conn) subscribe(conn).catch(() => {});
        }, 1000);
      }
    });
    await ch.prefetch(prefetch);
    await ch.consume(
      queue,
      (msg) => {
        if (!msg) return; // consumer cancelled by the broker (e.g. queue deleted)
        const task = processDelivery({ consumer: definition, channel: ch, msg })
          .catch((err) => logger.error(`[${definition.name}] unexpected processor error: ${err.stack ?? err}`))
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      },
      { noAck: false, consumerTag: `${definition.name}-${process.pid}-${myGeneration}` }
    );
    logger.info(`[${definition.name}] consuming ${queue} (prefetch ${prefetch})`);
  }

  return {
    name: definition.name,
    queue,
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribeReady = onBrokerReady((connection) => subscribe(connection));
    },
    /** Graceful: stop receiving, let in-flight deliveries finish (bounded), then close. */
    async stop({ timeoutMs = 10000 } = {}) {
      stopped = true;
      unsubscribeReady?.();
      const ch = channel;
      channel = null;
      generation += 1;
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0 && Date.now() < deadline) await sleep(50);
      try {
        await ch?.close();
      } catch {
        /* ignore */
      }
    },
    /** Abrupt: close the channel immediately WITHOUT waiting; unacked messages return to the queue. */
    async crash() {
      stopped = true;
      unsubscribeReady?.();
      const ch = channel;
      channel = null;
      generation += 1;
      try {
        await ch?.close();
      } catch {
        /* ignore */
      }
    },
    inFlightCount: () => inFlight.size,
  };
}
