/**
 * Retry Engine — exponential back-off using RabbitMQ delay queues (durable, survives restarts).
 *
 * Counting convention:
 *   attempt 1            = first execution
 *   retries 1..MAX_RETRIES follow, so maxAttempts = 1 + MAX_RETRIES
 *   delay before retry n = min(INITIAL_RETRY_DELAY_MS * MULTIPLIER^(n-1), MAX_RETRY_DELAY_MS)
 *   defaults (3, 1000, 10000, 2) -> delays 1000, 2000, 4000 ms -> 4 attempts in total
 *
 * Scheduling a retry = publishing a copy of the message (with publisher confirm) to
 * P.<consumer>.retry.<delay>ms. When its TTL expires RabbitMQ dead-letters it back to the
 * consumer's main queue. The original delivery is acked only AFTER the copy is confirmed.
 * No in-memory timers are involved, so pending retries survive consumer/backend restarts.
 */
import { config } from '../config/env.js';
import { publishConfirmed } from '../config/rabbitmq.js';

const { maxRetries, initialRetryDelayMs, maxRetryDelayMs } = config.events;
const multiplier = Number.isFinite(config.events.backoffMultiplier) && config.events.backoffMultiplier >= 1
  ? config.events.backoffMultiplier
  : 2;

export const maxAttempts = () => 1 + maxRetries;

/** Delay before retry number `retryNumber` (1-based). */
export function delayForRetry(retryNumber) {
  const raw = initialRetryDelayMs * multiplier ** Math.max(0, retryNumber - 1);
  return Math.round(Math.min(raw, maxRetryDelayMs));
}

/** All distinct delays that need a delay queue (plus the deferral delay). */
export function retryDelaysForTopology() {
  const delays = new Set([Math.max(1, initialRetryDelayMs)]);
  for (let n = 1; n <= maxRetries; n += 1) delays.add(Math.max(1, delayForRetry(n)));
  return [...delays].sort((a, b) => a - b);
}

export function retryPolicy() {
  return {
    maxRetries,
    maxAttempts: maxAttempts(),
    initialRetryDelayMs,
    maxRetryDelayMs,
    backoffMultiplier: multiplier,
    delaysMs: Array.from({ length: maxRetries }, (_, i) => delayForRetry(i + 1)),
  };
}

/**
 * Publishes a delayed copy of `msg` to the consumer's retry queue.
 * Lazily imports topology to avoid a circular import (topology needs retryDelaysForTopology).
 */
export async function scheduleRetry({ consumerName, msg, delayMs, headers }) {
  const { retryQueueName } = await import('../messaging/topology.js');
  const props = msg.properties ?? {};
  await publishConfirmed('', retryQueueName(consumerName, delayMs), msg.content, {
    persistent: true,
    contentType: props.contentType ?? 'application/json',
    messageId: props.messageId,
    correlationId: props.correlationId,
    type: props.type,
    timestamp: props.timestamp,
    headers: { ...(props.headers ?? {}), ...headers },
  });
}
