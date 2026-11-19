import { createHash, randomUUID } from 'node:crypto';
import { CURRENT_EVENT_VERSION, EVENT_TYPES } from './eventTypes.js';

/** Formats 16 bytes of a hash as a UUID-shaped string. */
function hashToUuid(input) {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deterministic ID for an event caused by another event. If the same causing event is ever
 * handled twice, the derived event gets the SAME ID, so the unique index on
 * outbox.eventId rejects the duplicate and consumers can deduplicate downstream.
 */
export const deriveEventId = (causationId, eventType, discriminator = '') =>
  hashToUuid(`${causationId}|${eventType}|${discriminator}`);

/**
 * Builds a standard event envelope.
 * @param {object} p
 * @param {string} p.eventType      one of EVENT_TYPES
 * @param {string} p.aggregateType  e.g. "Order"
 * @param {string} p.aggregateId    e.g. the order ID
 * @param {object} p.payload
 * @param {string} [p.correlationId] groups all events of one business flow (defaults to aggregateId)
 * @param {string} [p.causationId]   eventId of the event that caused this one
 * @param {string} [p.eventId]       explicit ID; otherwise derived from causationId or random
 */
export function createEvent({ eventType, aggregateType, aggregateId, payload, correlationId, causationId = null, eventId, metadata }) {
  if (!Object.values(EVENT_TYPES).includes(eventType)) throw new Error(`Unknown event type: ${eventType}`);
  return {
    eventId: eventId ?? (causationId ? deriveEventId(causationId, eventType) : randomUUID()),
    eventType,
    eventVersion: CURRENT_EVENT_VERSION,
    aggregateType,
    aggregateId: String(aggregateId),
    correlationId: String(correlationId ?? aggregateId),
    causationId,
    createdAt: new Date().toISOString(),
    payload,
    ...(metadata && { metadata }),
  };
}

/**
 * Creates a follow-up event caused by `parent` (same correlation, deterministic ID).
 * Metadata (e.g. isTestEvent / testBatchId) is inherited, so a synthetic flow stays synthetic.
 */
export const createChildEvent = (parent, { eventType, aggregateType = parent.aggregateType, aggregateId = parent.aggregateId, payload }) =>
  createEvent({
    eventType,
    aggregateType,
    aggregateId,
    payload,
    correlationId: parent.correlationId,
    causationId: parent.eventId,
    metadata: parent.metadata,
  });
