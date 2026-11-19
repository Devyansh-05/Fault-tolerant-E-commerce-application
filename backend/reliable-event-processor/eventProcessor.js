/**
 * RELIABLE EVENT PROCESSOR — the common processing pipeline used by every consumer.
 *
 *  RabbitMQ delivery
 *    │
 *    ├─ 1. parse + validate envelope/payload ── invalid ──► DLQ (PERMANENT), ack
 *    ├─ 2. Redis lease (SET NX PX)
 *    │      ├─ COMPLETED  ──► DUPLICATE, ack (no business effect)
 *    │      └─ PROCESSING (another copy in flight) ──► defer via delay queue, ack
 *    ├─ 3. MongoDB record (eventId+consumer, unique)
 *    │      ├─ COMPLETED/DLQ ──► DUPLICATE, ack   (covers Redis data loss)
 *    │      └─ otherwise     ──► PROCESSING, attempts += 1
 *    ├─ 4. fault hook (Stage 3) + business handler, inside ONE MongoDB transaction that also
 *    │     flips the record to COMPLETED  ⇒ business effect and "completed" commit atomically,
 *    │     so a crash can never leave "done but not recorded" (or the reverse)
 *    ├─ 5a. success ──► Redis COMPLETED marker, ack
 *    └─ 5b. failure ──► FAILED; transient & attempts left ──► confirmed copy to retry queue
 *                                                            (exponential back-off) ──► RETRYING
 *                       otherwise ──► confirmed copy to DLQ ──► DLQ
 *                       ack ONLY after the copy is confirmed by the broker
 *
 *  If bookkeeping itself fails (MongoDB/RabbitMQ unavailable), the delivery is nacked with
 *  requeue so the broker redelivers it later — the message is never dropped.
 *
 *  Guarantee: at-least-once delivery + idempotent processing ⇒ effectively-once business
 *  effects for database-backed side effects. It is NOT mathematically exactly-once.
 */
import { createHash } from 'node:crypto';
import { config } from '../config/env.js';
import { runInTransaction } from '../config/database.js';
import { EVENT_STATUS, FAILURE_TYPE } from '../models/index.js';
import { validateEvent } from '../events/eventSchema.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';
import { AlreadyCompletedError, errorMessage, isRetryable, PermanentError, ProcessingTimeoutError } from './errors.js';
import { acquireLease, LEASE_STATE, markCompleted, releaseLease } from './eventIdempotency.js';
import * as eventStatus from './eventStatus.js';
import { delayForRetry, maxAttempts, scheduleRetry } from './retryEngine.js';
import { sendToDeadLetterQueue } from './deadLetterHandler.js';
import { runAfterSuccess, runBeforeHandle } from './hooks.js';

function safeAck(channel, msg) {
  try {
    channel.ack(msg);
    return true;
  } catch (err) {
    // Channel already closed: the broker will redeliver; idempotency makes that harmless.
    logger.warn(`Ack failed (${err.message}); message will be redelivered and deduplicated`);
    return false;
  }
}

function safeNack(channel, msg, requeue) {
  try {
    channel.nack(msg, false, requeue);
  } catch (err) {
    logger.warn(`Nack failed (${err.message}); message will be redelivered when the channel recovers`);
  }
}

/**
 * Runs `work(signal)` with a deadline. On timeout the AbortSignal fires, so cooperative code
 * (e.g. an injected delay) stops instead of continuing in the background; the attempt itself
 * never starts its business transaction after the deadline (see executeAttempt).
 */
function withTimeout(work, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new ProcessingTimeoutError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

const deferralDelayMs = () => Math.max(1, config.events.initialRetryDelayMs);

/** Unparseable / schema-invalid / unroutable messages: permanent failure, straight to the DLQ. */
async function deadLetterInvalid({ consumerName, channel, msg, rawEvent, reason }) {
  const eventId =
    typeof rawEvent?.eventId === 'string' && rawEvent.eventId.length >= 8 && rawEvent.eventId.length <= 100
      ? rawEvent.eventId
      : `invalid-${createHash('sha256').update(msg.content).digest('hex').slice(0, 24)}`;
  logger.warn(`[${consumerName}] permanent failure for ${eventId}: ${reason}`);
  try {
    await sendToDeadLetterQueue({ consumerName, msg, eventId, attempts: 1, error: reason, failureType: FAILURE_TYPE.PERMANENT });
    await eventStatus.recordInvalidMessage(
      consumerName,
      eventId,
      rawEvent ?? { raw: msg.content.toString('utf8').slice(0, 2000) },
      reason,
      maxAttempts()
    );
    safeAck(channel, msg);
  } catch (err) {
    // Could not publish/record: reject without requeue -> RabbitMQ's native dead-lettering
    // (queue argument x-dead-letter-exchange) still moves it to the DLQ.
    logger.error(`[${consumerName}] could not dead-letter ${eventId} explicitly (${err.message}); using native DLX`);
    safeNack(channel, msg, false);
  }
}

async function handleDuplicate({ consumerName, channel, msg, eventId, reason, owner }) {
  await eventStatus.recordDuplicate(consumerName, eventId, reason);
  if (owner) await markCompleted(consumerName, eventId); // replaces our lease with COMPLETED
  safeAck(channel, msg);
  logger.debug(`[${consumerName}] duplicate ${eventId} acknowledged (${reason})`);
}

async function handleFailure({ consumerName, channel, msg, event, attempt, error, owner }) {
  const retryable = isRetryable(error);
  const failureType = retryable ? FAILURE_TYPE.TRANSIENT : FAILURE_TYPE.PERMANENT;
  const text = errorMessage(error);
  const limit = maxAttempts();

  await eventStatus.markFailed(consumerName, event.eventId, attempt, text, failureType);
  await releaseLease(consumerName, event.eventId, owner);

  if (retryable && attempt < limit) {
    const delayMs = delayForRetry(attempt); // retry number == attempts made so far
    await scheduleRetry({
      consumerName,
      msg,
      delayMs,
      headers: { 'x-attempt': attempt + 1, 'x-last-error': text.slice(0, 200) },
    });
    await eventStatus.markRetrying(consumerName, event.eventId, attempt, delayMs);
    logger.info(`[${consumerName}] ${event.eventType} ${event.eventId} attempt ${attempt}/${limit} failed (${text}); retry in ${delayMs} ms`);
  } else {
    const reason = retryable ? `Retries exhausted after ${attempt} attempt(s): ${text}` : `Permanent failure: ${text}`;
    await sendToDeadLetterQueue({ consumerName, msg, eventId: event.eventId, attempts: attempt, error: reason, failureType });
    await eventStatus.markDeadLettered(consumerName, event.eventId, attempt, reason, failureType);
    logger.warn(`[${consumerName}] ${event.eventType} ${event.eventId} moved to DLQ: ${reason}`);
  }
  safeAck(channel, msg);
}

/**
 * Processes one RabbitMQ delivery for a consumer.
 * @param {{consumer: {name:string, handlers:Record<string,Function>}, channel: import('amqplib').Channel, msg: import('amqplib').ConsumeMessage}} p
 */
export async function processDelivery({ consumer, channel, msg }) {
  const consumerName = consumer.name;
  const startedAt = Date.now();

  // --- 1. Parse & validate -----------------------------------------------------------
  let rawEvent = null;
  try {
    rawEvent = JSON.parse(msg.content.toString('utf8'));
  } catch {
    return deadLetterInvalid({ consumerName, channel, msg, rawEvent: null, reason: 'Message body is not valid JSON' });
  }
  const validation = validateEvent(rawEvent);
  if (!validation.success) {
    return deadLetterInvalid({ consumerName, channel, msg, rawEvent, reason: validation.error });
  }
  const event = validation.event;
  const handler = consumer.handlers[event.eventType];
  if (!handler) {
    return deadLetterInvalid({ consumerName, channel, msg, rawEvent, reason: `Consumer "${consumerName}" has no handler for ${event.eventType}` });
  }

  let owner = null;
  try {
    // --- 2. Redis lease (fast path) ------------------------------------------------------
    const lease = await acquireLease(consumerName, event.eventId);
    owner = lease.owner;
    if (lease.redisAvailable && !lease.acquired) {
      await eventStatus.recordReceived(consumerName, event, { maxAttempts: maxAttempts(), redelivered: msg.fields?.redelivered });
      if (lease.state === LEASE_STATE.COMPLETED) {
        return handleDuplicate({ consumerName, channel, msg, eventId: event.eventId, reason: 'Redis: already COMPLETED', owner: null });
      }
      // Another copy of this event is being processed right now. We cannot ack-and-forget
      // (that copy might crash), so re-check later through the delay queue.
      const delayMs = deferralDelayMs();
      await scheduleRetry({ consumerName, msg, delayMs, headers: { 'x-deferred': true } });
      await eventStatus.recordDeferred(consumerName, event.eventId, delayMs);
      safeAck(channel, msg);
      return undefined;
    }

    // --- 3. Durable record (MongoDB is the source of truth) ----------------------------
    const record = await eventStatus.recordReceived(consumerName, event, {
      maxAttempts: maxAttempts(),
      redelivered: msg.fields?.redelivered,
    });
    if (record.status === EVENT_STATUS.COMPLETED) {
      return handleDuplicate({ consumerName, channel, msg, eventId: event.eventId, reason: 'MongoDB: already COMPLETED', owner });
    }
    if (record.status === EVENT_STATUS.DLQ) {
      await eventStatus.recordDuplicate(consumerName, event.eventId, 'already dead-lettered');
      await releaseLease(consumerName, event.eventId, owner);
      safeAck(channel, msg);
      return undefined;
    }
    const attempt = await eventStatus.markProcessing(consumerName, event.eventId);
    if (attempt === null) {
      return handleDuplicate({ consumerName, channel, msg, eventId: event.eventId, reason: 'completed concurrently', owner });
    }

    // --- 4. Execute ------------------------------------------------------------------------
    try {
      await withTimeout(async (signal) => {
        await runBeforeHandle({ consumerName, event, attempt, maxAttempts: maxAttempts(), channel, msg, signal });
        // A timed-out attempt must not start its business transaction afterwards: the retry
        // copy owns the work now. (If the deadline passes while the transaction is already
        // running, the conditional COMPLETED claim still lets only one execution commit.)
        if (signal.aborted) throw signal.reason;
        await runInTransaction(async (session) => {
          if (signal.aborted) throw signal.reason;
          const claimed = await eventStatus.markCompletedInTransaction(consumerName, event.eventId, attempt, startedAt, session);
          if (!claimed) throw new AlreadyCompletedError();
          await handler(event, { session, attempt, consumerName });
        });
      }, config.events.processingTimeoutMs);
    } catch (error) {
      if (error instanceof AlreadyCompletedError) {
        return handleDuplicate({ consumerName, channel, msg, eventId: event.eventId, reason: 'completed by a concurrent delivery', owner });
      }
      if (!(error instanceof PermanentError) && error?.name !== 'TransientError') {
        logger.debug(`[${consumerName}] handler error: ${error?.stack ?? error}`);
      }
      return handleFailure({ consumerName, channel, msg, event, attempt, error, owner });
    }

    // --- 5. Success: business effect + COMPLETED are committed together ----------------
    await markCompleted(consumerName, event.eventId);
    safeAck(channel, msg);
    logger.info(`[${consumerName}] ${event.eventType} ${event.eventId} completed (attempt ${attempt}, ${Date.now() - startedAt} ms)`);
    runAfterSuccess({ consumerName, event, msg }).catch((err) => logger.warn(`[${consumerName}] afterSuccess hook failed: ${err.message}`));
    return undefined;
  } catch (infraError) {
    // Bookkeeping failed (e.g. MongoDB or RabbitMQ temporarily unavailable). Do NOT ack:
    // requeue after a short pause so the broker redelivers it once infrastructure recovers.
    logger.error(`[${consumerName}] infrastructure error while processing ${event.eventId}: ${infraError.message}; requeueing`);
    await releaseLease(consumerName, event.eventId, owner).catch(() => {});
    await sleep(1000);
    safeNack(channel, msg, true);
    return undefined;
  }
}
