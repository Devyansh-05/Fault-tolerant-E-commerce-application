/**
 * Event Status Tracking — durable per-(eventId, consumer) state in MongoDB.
 * All state transitions are conditional updates so that late or concurrent writers can never
 * move a COMPLETED record backwards (e.g. a timed-out attempt that committed after all).
 */
import { EventProcessing, EVENT_STATUS } from '../models/index.js';

const HISTORY_LIMIT = -50;
const pushHistory = (status, attempt, message = '') => ({
  history: { $each: [{ status, attempt, at: new Date(), message: String(message).slice(0, 500) }], $slice: HISTORY_LIMIT },
});

const TERMINAL = [EVENT_STATUS.COMPLETED, EVENT_STATUS.DLQ];

/**
 * Upserts the record for this delivery (status RECEIVED on first sight) and counts the delivery.
 * @returns the current document (lean)
 */
export async function recordReceived(consumerName, event, { maxAttempts, redelivered }) {
  const now = new Date();
  const update = {
    $setOnInsert: {
      eventId: event.eventId,
      consumerName,
      eventType: event.eventType,
      aggregateId: event.aggregateId ?? null,
      correlationId: event.correlationId ?? null,
      causationId: event.causationId ?? null,
      maxAttempts,
      status: EVENT_STATUS.RECEIVED,
      firstReceivedAt: now,
      isTestEvent: Boolean(event.metadata?.isTestEvent),
      testBatchId: event.metadata?.testBatchId ?? null,
      event,
      history: [{ status: EVENT_STATUS.RECEIVED, attempt: 0, at: now, message: redelivered ? 'redelivered by broker' : '' }],
    },
    $set: { lastReceivedAt: now },
    $inc: { deliveries: 1 },
  };
  try {
    return await EventProcessing.findOneAndUpdate({ eventId: event.eventId, consumerName }, update, {
      upsert: true,
      new: true,
      lean: true,
    });
  } catch (err) {
    // Two deliveries upserting at the same moment: the unique index lets one win; re-read.
    if (err?.code === 11000) {
      return EventProcessing.findOneAndUpdate(
        { eventId: event.eventId, consumerName },
        { $set: { lastReceivedAt: now }, $inc: { deliveries: 1 } },
        { new: true, lean: true }
      );
    }
    throw err;
  }
}

/** A copy of an already-finished event arrived again: record it, do not process it. */
export async function recordDuplicate(consumerName, eventId, reason) {
  await EventProcessing.updateOne(
    { eventId, consumerName },
    { $inc: { duplicateCount: 1 }, $push: pushHistory(EVENT_STATUS.DUPLICATE, 0, reason) }
  );
}

/** The lease is held by another delivery; this copy was postponed via a delay queue. */
export async function recordDeferred(consumerName, eventId, delayMs) {
  await EventProcessing.updateOne(
    { eventId, consumerName },
    { $inc: { deferredCount: 1 }, $push: pushHistory('DEFERRED', 0, `another delivery holds the processing lease; re-check in ${delayMs} ms`) }
  );
}

/**
 * RECEIVED/RETRYING/FAILED -> PROCESSING, incrementing `attempts`.
 * @returns the attempt number, or null if the record is already terminal.
 */
export async function markProcessing(consumerName, eventId) {
  const doc = await EventProcessing.findOneAndUpdate(
    { eventId, consumerName, status: { $nin: TERMINAL } },
    { $set: { status: EVENT_STATUS.PROCESSING, lastAttemptAt: new Date(), nextRetryAt: null }, $inc: { attempts: 1 } },
    { new: true, lean: true }
  );
  if (!doc) return null;
  await EventProcessing.updateOne({ _id: doc._id }, { $push: pushHistory(EVENT_STATUS.PROCESSING, doc.attempts) });
  return doc.attempts;
}

/**
 * Called INSIDE the business transaction: claims completion atomically with the business
 * writes. Returns false if the record is already terminal (another delivery won).
 */
export async function markCompletedInTransaction(consumerName, eventId, attempt, startedAt, session) {
  const result = await EventProcessing.updateOne(
    { eventId, consumerName, status: { $nin: TERMINAL } },
    {
      $set: {
        status: EVENT_STATUS.COMPLETED,
        completedAt: new Date(),
        lastError: null,
        failureType: null,
        nextRetryAt: null,
        processingMs: Date.now() - startedAt,
      },
      $push: pushHistory(EVENT_STATUS.COMPLETED, attempt),
    },
    { session }
  );
  return result.modifiedCount === 1;
}

/** Records a failed attempt (status FAILED). Never overwrites a terminal record. */
export async function markFailed(consumerName, eventId, attempt, errorText, failureType) {
  await EventProcessing.updateOne(
    { eventId, consumerName, status: { $nin: TERMINAL } },
    {
      $set: { status: EVENT_STATUS.FAILED, lastError: errorText, failureType },
      $inc: { failedAttempts: 1 },
      $push: pushHistory(EVENT_STATUS.FAILED, attempt, errorText),
    }
  );
}

/** FAILED -> RETRYING once the delayed retry copy has been confirmed by the broker. */
export async function markRetrying(consumerName, eventId, attempt, delayMs) {
  await EventProcessing.updateOne(
    { eventId, consumerName, status: EVENT_STATUS.FAILED },
    {
      $set: { status: EVENT_STATUS.RETRYING, nextRetryAt: new Date(Date.now() + delayMs) },
      $inc: { retryCount: 1 },
      $push: pushHistory(EVENT_STATUS.RETRYING, attempt, `retry ${attempt} scheduled in ${delayMs} ms`),
    }
  );
}

/** -> DLQ once the dead-letter copy has been confirmed by the broker. */
export async function markDeadLettered(consumerName, eventId, attempt, errorText, failureType) {
  await EventProcessing.updateOne(
    { eventId, consumerName, status: { $ne: EVENT_STATUS.COMPLETED } },
    {
      $set: { status: EVENT_STATUS.DLQ, dlqAt: new Date(), lastError: errorText, failureType, nextRetryAt: null },
      $push: pushHistory(EVENT_STATUS.DLQ, attempt, errorText),
    }
  );
}

/**
 * DLQ replay (admin): DLQ -> RETRYING with a fresh retry budget. The previous DLQ outcome is
 * preserved in `dlqHistory` (audit) and in `history`; nothing is marked successful here —
 * the record only becomes COMPLETED if the replayed delivery really succeeds.
 * @returns the updated record, or null if it is not (or no longer) in the DLQ
 */
export async function prepareReplay(consumerName, eventId, requestedBy) {
  const doc = await EventProcessing.findOne({ eventId, consumerName, status: EVENT_STATUS.DLQ }).lean();
  if (!doc) return null;
  const now = new Date();
  return EventProcessing.findOneAndUpdate(
    { _id: doc._id, status: EVENT_STATUS.DLQ },
    {
      $set: { status: EVENT_STATUS.RETRYING, attempts: 0, retryCount: 0, nextRetryAt: now, dlqAt: null, failureType: null },
      $inc: { replayCount: 1 },
      $push: {
        dlqHistory: { dlqAt: doc.dlqAt, attempts: doc.attempts, lastError: doc.lastError, failureType: doc.failureType, replayedAt: now, replayedBy: requestedBy },
        ...pushHistory('REPLAYED', 0, `replay from DLQ requested by ${requestedBy}; previous attempts: ${doc.attempts}`),
      },
    },
    { new: true, lean: true }
  );
}

/** Undo prepareReplay when the replay message could not be published. */
export async function revertReplay(consumerName, eventId, previous, reason) {
  await EventProcessing.updateOne(
    { eventId, consumerName, status: EVENT_STATUS.RETRYING, attempts: 0 },
    {
      $set: { status: EVENT_STATUS.DLQ, dlqAt: previous.dlqAt, attempts: previous.attempts, failureType: previous.failureType, nextRetryAt: null },
      $push: pushHistory(EVENT_STATUS.DLQ, previous.attempts, `replay not published: ${reason}`),
    }
  );
}

/** Records an unparseable / invalid message that has no usable envelope. */
export async function recordInvalidMessage(consumerName, pseudoEventId, rawEvent, errorText, maxAttempts) {
  const now = new Date();
  await EventProcessing.updateOne(
    { eventId: pseudoEventId, consumerName },
    {
      $setOnInsert: {
        eventId: pseudoEventId,
        consumerName,
        eventType: typeof rawEvent?.eventType === 'string' ? rawEvent.eventType.slice(0, 60) : 'INVALID',
        maxAttempts,
        firstReceivedAt: now,
        event: rawEvent ?? null,
      },
      $set: { status: EVENT_STATUS.DLQ, dlqAt: now, lastError: errorText, failureType: 'PERMANENT', lastReceivedAt: now, lastAttemptAt: now },
      $inc: { deliveries: 1, attempts: 1, failedAttempts: 1 },
      $push: pushHistory(EVENT_STATUS.DLQ, 1, errorText),
    },
    { upsert: true }
  );
}
