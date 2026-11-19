/**
 * OUTBOX PUBLISHER — moves committed outbox events from MongoDB to RabbitMQ.
 *
 * Loop (every OUTBOX_POLL_INTERVAL_MS):
 *  1. CLAIM: atomically flip one due event PENDING -> PUBLISHING with claimedBy/claimedAt
 *     (findOneAndUpdate). Concurrent publishers can never claim the same event at the same time.
 *     A PUBLISHING claim older than OUTBOX_CLAIM_TIMEOUT_MS is treated as abandoned (publisher
 *     crashed) and can be re-claimed.
 *  2. PUBLISH with publisher confirms (persistent message, messageId = eventId).
 *  3. On confirm: PUBLISHING -> PUBLISHED (only if we still own the claim).
 *     On failure (RabbitMQ down, nack, timeout): back to PENDING, publishAttempts/lastError
 *     recorded, nextAttemptAt = now + exponential back-off. The event is never discarded.
 *
 * IMPORTANT: "publish" and "mark PUBLISHED" are NOT atomic. If the publisher dies after the
 * broker confirmed but before step 3, the claim expires and the event is published AGAIN.
 * This is by design (at-least-once); consumers deduplicate by eventId.
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { onBrokerReady, publishConfirmed } from '../config/rabbitmq.js';
import { OutboxEvent, OUTBOX_STATUS } from '../models/index.js';
import { exchangeName } from '../messaging/topology.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';
import { toEnvelope } from './outboxService.js';

export function createOutboxPublisher(options = {}) {
  const settings = { ...config.outbox, ...options };
  const publisherId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  /** Test/fault-injection hooks: beforePublish(doc), afterConfirm(doc) — may throw to simulate a crash. */
  const hooks = { beforePublish: null, afterConfirm: null };
  let running = false;
  let loopPromise = null;
  let wakeUp = null;
  let unsubscribeReady = null;

  /** RabbitMQ is (back) up: make events that were waiting because of the outage due now. */
  async function onBrokerRecovered() {
    if (!running) return;
    const { modifiedCount } = await OutboxEvent.updateMany(
      { status: OUTBOX_STATUS.PENDING, nextAttemptAt: { $gt: new Date() } },
      { $set: { nextAttemptAt: new Date() } }
    );
    if (modifiedCount) logger.info(`[outbox] broker available - ${modifiedCount} waiting event(s) scheduled for immediate publishing`);
    wakeUp?.();
  }
  const stats = { published: 0, failed: 0, cycles: 0, lastCycleAt: null, lastError: null };

  async function claimNext() {
    const now = new Date();
    return OutboxEvent.findOneAndUpdate(
      {
        $or: [
          { status: OUTBOX_STATUS.PENDING, nextAttemptAt: { $lte: now } },
          { status: OUTBOX_STATUS.PUBLISHING, claimedAt: { $lt: new Date(now.getTime() - settings.claimTimeoutMs) } },
        ],
      },
      { $set: { status: OUTBOX_STATUS.PUBLISHING, claimedBy: publisherId, claimedAt: now }, $inc: { publishAttempts: 1 } },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, new: true, lean: true }
    );
  }

  async function publishOne(doc) {
    const envelope = toEnvelope(doc);
    try {
      if (hooks.beforePublish) await hooks.beforePublish(doc);
      await publishConfirmed(exchangeName(), doc.routingKey, Buffer.from(JSON.stringify(envelope)), {
        persistent: true,
        contentType: 'application/json',
        messageId: doc.eventId,
        correlationId: doc.correlationId,
        type: doc.eventType,
        timestamp: Math.floor(Date.now() / 1000),
        headers: { 'x-event-version': doc.eventVersion, 'x-publish-attempt': doc.publishAttempts },
      });
    } catch (err) {
      stats.failed += 1;
      stats.lastError = err.message;
      const backoff = Math.min(500 * 2 ** Math.min(doc.publishAttempts - 1, 10), settings.maxBackoffMs);
      await OutboxEvent.updateOne(
        { _id: doc._id, claimedBy: publisherId, status: OUTBOX_STATUS.PUBLISHING },
        {
          $set: {
            status: OUTBOX_STATUS.PENDING,
            lastError: err.message,
            nextAttemptAt: new Date(Date.now() + backoff),
            claimedBy: null,
            claimedAt: null,
          },
        }
      );
      logger.warn(`[outbox] publish failed for ${doc.eventType} ${doc.eventId} (attempt ${doc.publishAttempts}): ${err.message}; retry in ${backoff} ms`);
      return false;
    }

    // The broker has the message. From here on a crash means "published but not marked".
    await OutboxEvent.updateOne({ _id: doc._id }, { $inc: { publishCount: 1 } });
    if (hooks.afterConfirm) await hooks.afterConfirm(doc);

    await OutboxEvent.updateOne(
      { _id: doc._id, claimedBy: publisherId, status: OUTBOX_STATUS.PUBLISHING },
      { $set: { status: OUTBOX_STATUS.PUBLISHED, publishedAt: new Date(), lastError: null, claimedBy: null } }
    );
    stats.published += 1;
    logger.debug(`[outbox] published ${doc.eventType} ${doc.eventId}`);
    return true;
  }

  /** Publishes up to one batch of due events. Returns how many were attempted. */
  async function runOnce() {
    let attempted = 0;
    while (attempted < settings.batchSize) {
      const doc = await claimNext();
      if (!doc) break;
      attempted += 1;
      try {
        const ok = await publishOne(doc);
        if (!ok) break; // broker trouble: stop this cycle, back-off applies per event
      } catch (err) {
        // A hook simulated a crash after confirm (or MongoDB failed). The claim stays
        // PUBLISHING and will be re-claimed after claimTimeoutMs -> possible re-publish.
        stats.lastError = err.message;
        logger.warn(`[outbox] interrupted while finishing ${doc.eventId}: ${err.message}`);
        break;
      }
    }
    stats.cycles += 1;
    stats.lastCycleAt = new Date();
    return attempted;
  }

  async function loop() {
    while (running) {
      let attempted = 0;
      try {
        attempted = await runOnce();
      } catch (err) {
        stats.lastError = err.message;
        logger.error(`[outbox] cycle failed: ${err.message}`);
      }
      if (!running) break;
      // Busy -> continue immediately; idle -> wait for the poll interval (or a nudge).
      if (attempted < settings.batchSize) {
        await Promise.race([sleep(settings.pollIntervalMs), new Promise((resolve) => (wakeUp = resolve))]);
        wakeUp = null;
      }
    }
  }

  return {
    publisherId,
    hooks,
    stats,
    runOnce,
    start() {
      if (running) return;
      running = true;
      loopPromise = loop();
      unsubscribeReady = onBrokerReady(() => onBrokerRecovered().catch((err) => logger.warn(`[outbox] ${err.message}`)));
      logger.info(`[outbox] publisher ${publisherId} started (poll ${settings.pollIntervalMs} ms)`);
    },
    nudge() {
      wakeUp?.();
    },
    async stop() {
      running = false;
      unsubscribeReady?.();
      wakeUp?.();
      await loopPromise;
      loopPromise = null;
    },
  };
}
