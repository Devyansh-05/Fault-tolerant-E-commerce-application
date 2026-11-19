import { OutboxEvent, OUTBOX_STATUS } from '../models/index.js';
import { routingKeyFor } from '../events/eventTypes.js';

/**
 * Stores events in the outbox. MUST be called with the session of the business
 * transaction so that "business change + event" commit atomically (no dual write).
 *
 * @param {object[]} events  envelopes from events/eventFactory.js
 * @param {import('mongoose').ClientSession} session
 */
export async function addToOutbox(events, session, { source = 'application' } = {}) {
  if (!session) throw new Error('addToOutbox requires a transaction session');
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) return [];
  return OutboxEvent.create(
    list.map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      routingKey: routingKeyFor(event.eventType),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      causationId: event.causationId ?? null,
      payload: event.payload,
      eventCreatedAt: new Date(event.createdAt),
      status: OUTBOX_STATUS.PENDING,
      nextAttemptAt: new Date(),
      source: event.metadata?.source ?? source,
      isTestEvent: Boolean(event.metadata?.isTestEvent),
      testBatchId: event.metadata?.testBatchId ?? null,
    })),
    { session, ordered: true }
  );
}

/** Rebuilds the wire envelope from a stored outbox document. */
export function toEnvelope(doc) {
  return {
    eventId: doc.eventId,
    eventType: doc.eventType,
    eventVersion: doc.eventVersion,
    aggregateType: doc.aggregateType,
    aggregateId: doc.aggregateId,
    correlationId: doc.correlationId,
    causationId: doc.causationId ?? null,
    createdAt: new Date(doc.eventCreatedAt).toISOString(),
    payload: doc.payload,
    ...(doc.isTestEvent && {
      metadata: { isTestEvent: true, ...(doc.testBatchId && { testBatchId: doc.testBatchId }), source: doc.source },
    }),
  };
}
