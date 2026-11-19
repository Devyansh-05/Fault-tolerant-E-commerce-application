import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';

/**
 * Durable event-processing record — ONE document per (eventId, consumerName).
 * This is the source of truth for event idempotency (Redis is the fast path) and the data
 * source for the Stage 3 Reliability Dashboard.
 *
 * Status lifecycle:
 *   RECEIVED -> PROCESSING -> COMPLETED
 *                          -> FAILED -> RETRYING -> PROCESSING ... (transient errors)
 *                          -> FAILED -> DLQ                         (retries exhausted / permanent)
 * DUPLICATE is recorded in `history` (and counted in duplicateCount) whenever a copy of an
 * already-completed event is delivered again; the record itself stays COMPLETED.
 */
export const EVENT_STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  RETRYING: 'RETRYING',
  FAILED: 'FAILED',
  DLQ: 'DLQ',
  DUPLICATE: 'DUPLICATE',
});

export const FAILURE_TYPE = Object.freeze({ TRANSIENT: 'TRANSIENT', PERMANENT: 'PERMANENT' });

const historySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    attempt: { type: Number, default: 0 },
    at: { type: Date, default: Date.now },
    message: { type: String, default: '' },
  },
  { _id: false }
);

const eventProcessingSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    consumerName: { type: String, required: true },
    eventType: { type: String, required: true },
    aggregateId: { type: String, default: null },
    correlationId: { type: String, default: null },
    causationId: { type: String, default: null },

    status: { type: String, enum: Object.values(EVENT_STATUS), default: EVENT_STATUS.RECEIVED },
    attempts: { type: Number, default: 0 }, // handler executions (attempt 1 = first try)
    retryCount: { type: Number, default: 0 }, // retries scheduled
    maxAttempts: { type: Number, required: true },
    deliveries: { type: Number, default: 0 }, // every delivery from RabbitMQ (incl. duplicates)
    duplicateCount: { type: Number, default: 0 },
    deferredCount: { type: Number, default: 0 }, // deliveries postponed because another copy held the lease
    failedAttempts: { type: Number, default: 0 }, // attempts that ended in an error (each FAILED transition)
    replayCount: { type: Number, default: 0 }, // admin replays from the DLQ (Stage 3)

    // Synthetic test events (Stage 3 generator) — copied from the event metadata.
    isTestEvent: { type: Boolean, default: false },
    testBatchId: { type: String, default: null },

    lastError: { type: String, default: null },
    failureType: { type: String, enum: [...Object.values(FAILURE_TYPE), null], default: null },
    processingMs: { type: Number, default: null },

    firstReceivedAt: { type: Date, default: Date.now },
    lastReceivedAt: { type: Date, default: Date.now },
    lastAttemptAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    dlqAt: { type: Date, default: null },

    // Full original event, preserved for DLQ inspection and (Stage 3) replay.
    event: { type: mongoose.Schema.Types.Mixed, required: true },
    history: { type: [historySchema], default: [] },
    // Audit trail of every time this record was dead-lettered and then replayed by an admin.
    dlqHistory: {
      type: [
        new mongoose.Schema(
          {
            dlqAt: Date,
            attempts: Number,
            lastError: String,
            failureType: String,
            replayedAt: Date,
            replayedBy: String,
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, minimize: false }
);

// Each consumer keeps its OWN state for the same event (EVT1 + payment, EVT1 + inventory, ...).
eventProcessingSchema.index({ eventId: 1, consumerName: 1 }, { unique: true, name: 'uniq_event_consumer' });
eventProcessingSchema.index({ status: 1, updatedAt: -1 });
eventProcessingSchema.index({ consumerName: 1, status: 1 });
eventProcessingSchema.index({ eventType: 1 });
eventProcessingSchema.index({ correlationId: 1 });
eventProcessingSchema.index({ updatedAt: -1 });
eventProcessingSchema.index({ isTestEvent: 1, testBatchId: 1 });

eventProcessingSchema.plugin(toJSONPlugin);

export const EventProcessing =
  mongoose.models.EventProcessing || mongoose.model('EventProcessing', eventProcessingSchema, 'event_processing');
