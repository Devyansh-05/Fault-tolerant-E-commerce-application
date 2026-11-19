/**
 * Administrative operations on existing events (Stage 3):
 *   - redeliverEvent:    deliver an already-created event AGAIN with the same eventId
 *                        (duplicate-delivery demonstration)
 *   - replayDeadLetter:  put a dead-lettered event back into its consumer's queue
 * Both go through RabbitMQ and the real Reliable Event Processor; neither marks anything as
 * successful by itself.
 */
import { isBrokerConnected, publishConfirmed } from '../config/rabbitmq.js';
import { EventProcessing, EVENT_STATUS, OutboxEvent, OUTBOX_STATUS } from '../models/index.js';
import { CONSUMER_BINDINGS, exchangeName, mainQueueName } from '../messaging/topology.js';
import { toEnvelope } from '../outbox/outboxService.js';
import { validateEvent } from '../events/eventSchema.js';
import { prepareReplay, revertReplay } from '../reliable-event-processor/eventStatus.js';
import { clearIdempotencyMarker } from '../reliable-event-processor/eventIdempotency.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

function requireBroker() {
  if (!isBrokerConnected()) throw new AppError(503, 'BROKER_UNAVAILABLE', 'RabbitMQ is not connected; try again when it is available');
}

const messageProps = (envelope, headers) => ({
  persistent: true,
  contentType: 'application/json',
  messageId: envelope.eventId,
  correlationId: envelope.correlationId,
  type: envelope.eventType,
  headers,
});

/** Re-delivers an existing (published) event `copies` times — same eventId, same body. */
export async function redeliverEvent({ eventId, copies, consumer }, admin) {
  const doc = await OutboxEvent.findOne({ eventId }).lean();
  if (!doc) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this eventId exists in the outbox');
  if (doc.status !== OUTBOX_STATUS.PUBLISHED) {
    throw new AppError(409, 'EVENT_NOT_PUBLISHED', 'This event has not been published yet; wait until it is PUBLISHED');
  }
  const subscribers = Object.entries(CONSUMER_BINDINGS).filter(([, keys]) => keys.includes(doc.routingKey)).map(([name]) => name);
  if (consumer && !subscribers.includes(consumer)) {
    throw new AppError(400, 'CONSUMER_NOT_SUBSCRIBED', `${consumer} does not receive ${doc.eventType} (receivers: ${subscribers.join(', ')})`);
  }
  requireBroker();

  const envelope = toEnvelope(doc);
  const content = Buffer.from(JSON.stringify(envelope));
  try {
    for (let i = 1; i <= copies; i += 1) {
      const headers = { 'x-simulated-duplicate': i, 'x-redelivered-by': admin.email };
      if (consumer) await publishConfirmed('', mainQueueName(consumer), content, messageProps(envelope, headers));
      else await publishConfirmed(exchangeName(), doc.routingKey, content, messageProps(envelope, headers));
    }
  } catch (err) {
    throw new AppError(503, 'BROKER_UNAVAILABLE', `Could not publish the duplicate: ${err.message}`);
  }
  logger.info(`[testing] ${admin.email} re-delivered ${doc.eventType} ${eventId} x${copies} to ${consumer ?? subscribers.join(', ')}`);
  return { eventId, eventType: doc.eventType, copies, deliveredTo: consumer ? [consumer] : subscribers };
}

/**
 * DLQ replay for one consumer. The record keeps its DLQ history (audit), gets a fresh retry
 * budget and status RETRYING; it becomes COMPLETED only if the replayed delivery succeeds.
 * Business guards (unique payment reference, one reservation per order, unique notification)
 * make the replay safe even if part of the work had already happened.
 */
export async function replayDeadLetter(eventId, consumer, admin) {
  const record = await EventProcessing.findOne({ eventId, consumerName: consumer }).lean();
  if (!record) throw new AppError(404, 'EVENT_NOT_FOUND', 'No processing record for this event and consumer');
  if (record.status !== EVENT_STATUS.DLQ) {
    throw new AppError(409, 'NOT_IN_DLQ', `The event is ${record.status}, not in the DLQ`);
  }
  const validation = validateEvent(record.event);
  if (!validation.success) {
    throw new AppError(422, 'EVENT_NOT_REPLAYABLE', `This message is invalid and cannot be replayed: ${validation.error}`);
  }
  requireBroker();

  const updated = await prepareReplay(consumer, eventId, admin.email);
  if (!updated) throw new AppError(409, 'NOT_IN_DLQ', 'The event left the DLQ concurrently');
  await clearIdempotencyMarker(consumer, eventId);

  const envelope = validation.event;
  try {
    await publishConfirmed(
      '',
      mainQueueName(consumer),
      Buffer.from(JSON.stringify(envelope)),
      messageProps(envelope, { 'x-dlq-replay': updated.replayCount, 'x-replayed-by': admin.email })
    );
  } catch (err) {
    await revertReplay(consumer, eventId, { dlqAt: record.dlqAt, attempts: record.attempts, failureType: record.failureType }, err.message);
    throw new AppError(503, 'BROKER_UNAVAILABLE', `Replay could not be published: ${err.message}`);
  }
  logger.info(`[dlq] ${admin.email} replayed ${record.eventType} ${eventId} for ${consumer} (replay #${updated.replayCount})`);
  return {
    eventId,
    consumer,
    status: updated.status,
    replayCount: updated.replayCount,
    message: 'Replay queued. The record becomes COMPLETED only if processing succeeds; otherwise it is retried and may return to the DLQ.',
  };
}
