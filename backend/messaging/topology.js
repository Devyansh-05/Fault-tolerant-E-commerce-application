/**
 * RabbitMQ topology (declared idempotently on every (re)connect).
 *
 *   <exchange>            topic, durable  — all business events (routing key = event type)
 *   <exchange>.dlx        direct, durable — dead-letter exchange (routing key = consumer name)
 *
 * Per consumer <c> (prefix P):
 *   P.<c>.queue           durable main queue, bound to the consumer's routing keys.
 *                         x-dead-letter-exchange = <exchange>.dlx (for messages rejected with nack)
 *   P.<c>.retry.<d>ms     durable delay queue per back-off delay d: x-message-ttl = d and
 *                         dead-letters back to P.<c>.queue via the default exchange.
 *                         One queue per delay avoids head-of-line blocking of per-message TTLs.
 *   P.<c>.dlq             durable dead-letter queue (never auto-deleted, inspected by admins)
 */
import { config } from '../config/env.js';
import { ROUTING_KEYS } from '../events/eventTypes.js';
import { retryDelaysForTopology } from '../reliable-event-processor/retryEngine.js';

export const CONSUMER_NAMES = Object.freeze({
  PAYMENT: 'payment',
  INVENTORY: 'inventory',
  ORDER: 'order',
  EMAIL: 'email',
});

/** Which events each consumer receives. */
export const CONSUMER_BINDINGS = Object.freeze({
  [CONSUMER_NAMES.PAYMENT]: [ROUTING_KEYS.ORDER_CREATED],
  [CONSUMER_NAMES.INVENTORY]: [ROUTING_KEYS.ORDER_CREATED],
  [CONSUMER_NAMES.ORDER]: [
    ROUTING_KEYS.PAYMENT_COMPLETED,
    ROUTING_KEYS.PAYMENT_FAILED,
    ROUTING_KEYS.INVENTORY_RESERVED,
    ROUTING_KEYS.INVENTORY_FAILED,
  ],
  [CONSUMER_NAMES.EMAIL]: [ROUTING_KEYS.ORDER_CONFIRMED, ROUTING_KEYS.ORDER_FAILED, ROUTING_KEYS.EMAIL_NOTIFICATION_REQUESTED],
});

export const exchangeName = () => config.rabbitmq.exchange;
export const deadLetterExchangeName = () => `${config.rabbitmq.exchange}.dlx`;
export const mainQueueName = (consumer) => `${config.rabbitmq.queuePrefix}.${consumer}.queue`;
export const dlqName = (consumer) => `${config.rabbitmq.queuePrefix}.${consumer}.dlq`;
export const retryQueueName = (consumer, delayMs) => `${config.rabbitmq.queuePrefix}.${consumer}.retry.${delayMs}ms`;

export function describeTopology() {
  return Object.entries(CONSUMER_BINDINGS).map(([consumer, routingKeys]) => ({
    consumer,
    queue: mainQueueName(consumer),
    routingKeys,
    retryQueues: retryDelaysForTopology().map((d) => retryQueueName(consumer, d)),
    dlq: dlqName(consumer),
  }));
}

/** Declares exchanges, queues and bindings. Safe to call repeatedly. */
export async function assertTopology(channel) {
  const exchange = exchangeName();
  const dlx = deadLetterExchangeName();
  await channel.assertExchange(exchange, 'topic', { durable: true });
  await channel.assertExchange(dlx, 'direct', { durable: true });

  for (const [consumer, routingKeys] of Object.entries(CONSUMER_BINDINGS)) {
    const queue = mainQueueName(consumer);
    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': dlx, 'x-dead-letter-routing-key': consumer },
    });
    for (const key of routingKeys) await channel.bindQueue(queue, exchange, key);

    await channel.assertQueue(dlqName(consumer), { durable: true });
    await channel.bindQueue(dlqName(consumer), dlx, consumer);

    for (const delay of retryDelaysForTopology()) {
      await channel.assertQueue(retryQueueName(consumer, delay), {
        durable: true,
        arguments: {
          'x-message-ttl': delay,
          'x-dead-letter-exchange': '', // default exchange -> routes by queue name
          'x-dead-letter-routing-key': queue,
        },
      });
    }
  }
}
