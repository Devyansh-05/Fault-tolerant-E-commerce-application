/**
 * Read-only monitoring queries for the Reliability Dashboard.
 * Every number is computed from the durable event_processing / outbox_events collections
 * (and live RabbitMQ queue depths) — nothing is estimated or hard-coded.
 *
 * Definitions (used consistently by the API and the UI):
 *   logical event        one event created by the system (one outbox document / one eventId)
 *   processing record    one logical event as handled by ONE consumer (event_processing doc).
 *                        ORDER_CREATED has 2 records (payment + inventory); retries do NOT
 *                        create new records — they increase `attempts` on the same record.
 *   attempts             executions of a consumer handler (attempt 1 + retries)
 *   failed attempts      attempts that ended in an error (each FAILED transition)
 *   duplicate deliveries copies of an already-finished event that were recognised and skipped
 */
import { EventProcessing, EVENT_STATUS, OutboxEvent, OUTBOX_STATUS } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex, paginate } from '../utils/helpers.js';
import { getBrokerStatus, getQueueDepth } from '../config/rabbitmq.js';
import { CONSUMER_BINDINGS, describeTopology, dlqName, mainQueueName } from '../messaging/topology.js';
import { retryPolicy } from '../reliable-event-processor/retryEngine.js';
import { getLeaseState } from '../reliable-event-processor/eventIdempotency.js';

const LIST_PROJECTION = { event: 0, history: 0, dlqHistory: 0 };

/** Adds the test/real scope and batch filter (same field name on both collections). */
function scopeFilter({ scope = 'all', batchId } = {}) {
  const filter = {};
  if (scope === 'test') filter.isTestEvent = true;
  if (scope === 'real') filter.isTestEvent = { $ne: true };
  if (batchId) filter.testBatchId = batchId;
  return filter;
}

function buildFilter({ status, consumer, eventType, q, correlationId, from, to, ...scope }) {
  const filter = scopeFilter(scope);
  if (status) filter.status = status;
  if (consumer) filter.consumerName = consumer;
  if (eventType) filter.eventType = eventType;
  if (correlationId) filter.correlationId = correlationId;
  if (q) filter.eventId = new RegExp(`^${escapeRegex(q)}`, 'i');
  if (from || to) {
    filter.firstReceivedAt = {};
    if (from) filter.firstReceivedAt.$gte = from;
    if (to) filter.firstReceivedAt.$lte = to;
  }
  return filter;
}

export async function listEventRecords({ page, limit, ...criteria }) {
  const filter = buildFilter(criteria);
  const [records, total] = await Promise.all([
    EventProcessing.find(filter, LIST_PROJECTION).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    EventProcessing.countDocuments(filter),
  ]);
  return { records: records.map((r) => r.toJSON()), pagination: paginate({ page, limit, total }) };
}

/** Everything known about one event: per-consumer records, outbox entry, follow-up events. */
export async function getEventDetails(eventId) {
  const [records, outbox, children] = await Promise.all([
    EventProcessing.find({ eventId }).sort({ consumerName: 1 }),
    OutboxEvent.findOne({ eventId }),
    OutboxEvent.find({ causationId: eventId }, { payload: 0 }).sort({ createdAt: 1 }),
  ]);
  if (records.length === 0 && !outbox) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');

  const redis = {};
  for (const record of records) redis[record.consumerName] = await getLeaseState(record.consumerName, eventId);

  return {
    eventId,
    eventType: outbox?.eventType ?? records[0]?.eventType,
    isTestEvent: Boolean(outbox?.isTestEvent ?? records[0]?.isTestEvent),
    testBatchId: outbox?.testBatchId ?? records[0]?.testBatchId ?? null,
    outbox: outbox?.toJSON() ?? null,
    consumers: records.map((r) => r.toJSON()),
    redisState: redis,
    childEvents: children.map((c) => c.toJSON()),
  };
}

const EMPTY_TOTALS = {
  records: 0, distinctEvents: 0, deliveries: 0, attempts: 0, failedAttempts: 0, duplicateDeliveries: 0,
  recordsWithDuplicates: 0, retriedRecords: 0, totalRetries: 0, deferred: 0, replays: 0, avgProcessingMs: null,
};

export async function getEventStats(query = {}) {
  const scope = scopeFilter(query);
  const [byStatus, totals, outboxByStatus, republished, recent, testEvents] = await Promise.all([
    EventProcessing.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    EventProcessing.aggregate([
      { $match: scope },
      {
        $group: {
          _id: null,
          records: { $sum: 1 },
          distinctEvents: { $addToSet: '$eventId' },
          deliveries: { $sum: '$deliveries' },
          attempts: { $sum: '$attempts' },
          failedAttempts: { $sum: { $ifNull: ['$failedAttempts', 0] } },
          duplicateDeliveries: { $sum: '$duplicateCount' },
          recordsWithDuplicates: { $sum: { $cond: [{ $gt: ['$duplicateCount', 0] }, 1, 0] } },
          retriedRecords: { $sum: { $cond: [{ $gt: ['$retryCount', 0] }, 1, 0] } },
          totalRetries: { $sum: '$retryCount' },
          deferred: { $sum: '$deferredCount' },
          replays: { $sum: { $ifNull: ['$replayCount', 0] } },
          avgProcessingMs: { $avg: '$processingMs' },
        },
      },
      { $set: { distinctEvents: { $size: '$distinctEvents' }, avgProcessingMs: { $round: ['$avgProcessingMs', 1] } } },
      { $project: { _id: 0 } },
    ]),
    OutboxEvent.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    OutboxEvent.countDocuments({ ...scope, publishCount: { $gt: 1 } }),
    EventProcessing.countDocuments({ ...scope, updatedAt: { $gte: new Date(Date.now() - 60_000) } }),
    OutboxEvent.countDocuments({ ...scope, isTestEvent: true }),
  ]);

  const statusCounts = Object.fromEntries(Object.values(EVENT_STATUS).map((s) => [s, 0]));
  byStatus.forEach(({ _id, count }) => (statusCounts[_id] = count));
  const outboxCounts = Object.fromEntries(Object.values(OUTBOX_STATUS).map((s) => [s, 0]));
  outboxByStatus.forEach(({ _id, count }) => (outboxCounts[_id] = count));
  const t = { ...EMPTY_TOTALS, ...(totals[0] ?? {}) };
  const logicalEvents = Object.values(outboxCounts).reduce((a, b) => a + b, 0);

  return {
    scope: { scope: query.scope ?? 'all', batchId: query.batchId ?? null },
    // Logical events (outbox) vs consumer processing records (event_processing).
    logicalEvents,
    testEventsGenerated: testEvents,
    processingRecords: t.records,
    distinctEvents: t.distinctEvents,
    deliveries: t.deliveries,
    attempts: t.attempts,
    byStatus: statusCounts,
    successful: statusCounts.COMPLETED,
    currentlyProcessing: statusCounts.PROCESSING + statusCounts.RECEIVED,
    retrying: statusCounts.RETRYING,
    failed: statusCounts.FAILED, // records whose latest attempt failed and whose retry is being scheduled
    failedAttempts: t.failedAttempts,
    inDlq: statusCounts.DLQ,
    retried: t.retriedRecords,
    totalRetries: t.totalRetries,
    duplicateDeliveries: t.duplicateDeliveries,
    recordsWithDuplicates: t.recordsWithDuplicates,
    deferredDeliveries: t.deferred,
    replays: t.replays,
    avgProcessingMs: t.avgProcessingMs,
    updatedInLastMinute: recent,
    outbox: { total: logicalEvents, byStatus: outboxCounts, publishedMoreThanOnce: republished },
    broker: getBrokerStatus(),
    retryPolicy: retryPolicy(),
    generatedAt: new Date().toISOString(),
  };
}

export async function getConsumerStats(query = {}) {
  const rows = await EventProcessing.aggregate([
    { $match: scopeFilter(query) },
    {
      $group: {
        _id: { consumer: '$consumerName', status: '$status' },
        count: { $sum: 1 },
        attempts: { $sum: '$attempts' },
        failedAttempts: { $sum: { $ifNull: ['$failedAttempts', 0] } },
        duplicates: { $sum: '$duplicateCount' },
        retries: { $sum: '$retryCount' },
        avgProcessingMs: { $avg: '$processingMs' },
      },
    },
  ]);

  const consumers = {};
  for (const name of Object.keys(CONSUMER_BINDINGS)) {
    consumers[name] = {
      consumer: name,
      routingKeys: CONSUMER_BINDINGS[name],
      total: 0,
      byStatus: Object.fromEntries(Object.values(EVENT_STATUS).map((s) => [s, 0])),
      attempts: 0,
      failedAttempts: 0,
      duplicates: 0,
      retries: 0,
      avgProcessingMs: null,
      queue: { name: mainQueueName(name), depth: null, consumers: null },
      dlq: { name: dlqName(name), depth: null },
    };
  }
  for (const row of rows) {
    const c = consumers[row._id.consumer];
    if (!c) continue;
    c.total += row.count;
    c.byStatus[row._id.status] = row.count;
    c.attempts += row.attempts;
    c.failedAttempts += row.failedAttempts;
    c.duplicates += row.duplicates;
    c.retries += row.retries;
    if (row._id.status === EVENT_STATUS.COMPLETED && row.avgProcessingMs != null) c.avgProcessingMs = Math.round(row.avgProcessingMs);
  }
  await Promise.all(
    Object.values(consumers).map(async (c) => {
      const [main, dead] = await Promise.all([getQueueDepth(c.queue.name), getQueueDepth(c.dlq.name)]);
      c.queue.depth = main?.messages ?? null;
      c.queue.consumers = main?.consumers ?? null;
      c.dlq.depth = dead?.messages ?? null;
    })
  );
  return { consumers: Object.values(consumers), broker: getBrokerStatus() };
}

export async function listDeadLetters({ page, limit, consumer, scope }) {
  const filter = { ...scopeFilter({ scope }), status: EVENT_STATUS.DLQ, ...(consumer && { consumerName: consumer }) };
  const [records, total] = await Promise.all([
    EventProcessing.find(filter).sort({ dlqAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    EventProcessing.countDocuments(filter),
  ]);
  const queues = await Promise.all(
    Object.keys(CONSUMER_BINDINGS).map(async (name) => ({ consumer: name, queue: dlqName(name), messages: (await getQueueDepth(dlqName(name)))?.messages ?? null }))
  );
  return { records: records.map((r) => r.toJSON()), pagination: paginate({ page, limit, total }), queues };
}

export async function listOutbox({ page, limit, status, eventType, scope }) {
  const filter = { ...scopeFilter({ scope }), ...(status && { status }), ...(eventType && { eventType }) };
  const [events, total] = await Promise.all([
    OutboxEvent.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    OutboxEvent.countDocuments(filter),
  ]);
  return { events: events.map((e) => e.toJSON()), pagination: paginate({ page, limit, total }) };
}

export function getProcessingConfig() {
  return { retry: retryPolicy(), topology: describeTopology() };
}
