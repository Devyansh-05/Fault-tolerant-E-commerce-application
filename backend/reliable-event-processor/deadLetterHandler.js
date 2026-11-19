/**
 * Dead Letter Handler. Moves an event that cannot be processed (retries exhausted or a
 * permanent failure) to the consumer's DLQ:  <exchange>.dlx --(consumer name)--> P.<consumer>.dlq
 *
 * The ORIGINAL message body is preserved byte-for-byte; failure information travels in headers.
 * The publish waits for the broker confirmation; only then may the caller ack the original
 * delivery. DLQ messages are never deleted automatically. The same information (including the
 * full event) is also stored durably in MongoDB (event_processing.status = DLQ) for the dashboard.
 */
import { publishConfirmed } from '../config/rabbitmq.js';
import { deadLetterExchangeName } from '../messaging/topology.js';

export async function sendToDeadLetterQueue({ consumerName, msg, eventId, attempts, error, failureType }) {
  const props = msg.properties ?? {};
  await publishConfirmed(deadLetterExchangeName(), consumerName, msg.content, {
    persistent: true,
    contentType: props.contentType ?? 'application/json',
    messageId: props.messageId ?? eventId,
    correlationId: props.correlationId,
    type: props.type,
    timestamp: Math.floor(Date.now() / 1000),
    headers: {
      ...(props.headers ?? {}),
      'x-dlq-consumer': consumerName,
      'x-dlq-event-id': eventId ?? null,
      'x-dlq-attempts': attempts,
      'x-dlq-failure-type': failureType,
      'x-dlq-error': String(error).slice(0, 1000),
      'x-dlq-original-routing-key': msg.fields?.routingKey ?? null,
      'x-dlq-failed-at': new Date().toISOString(),
    },
  });
}
