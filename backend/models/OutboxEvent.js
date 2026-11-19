import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';

/**
 * Transactional Outbox. Business code inserts events here INSIDE the same MongoDB
 * transaction as its business writes; the Outbox Publisher later publishes them to RabbitMQ.
 *
 * PENDING    -> waiting to be published (also after a failed publish attempt)
 * PUBLISHING -> claimed by a publisher (claimedBy/claimedAt). A stale claim is re-claimed.
 * PUBLISHED  -> the broker confirmed the message
 */
export const OUTBOX_STATUS = Object.freeze({ PENDING: 'PENDING', PUBLISHING: 'PUBLISHING', PUBLISHED: 'PUBLISHED' });

const outboxEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    eventType: { type: String, required: true },
    eventVersion: { type: Number, required: true, default: 1 },
    routingKey: { type: String, required: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: String, required: true },
    correlationId: { type: String, required: true },
    causationId: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    eventCreatedAt: { type: Date, required: true },

    status: { type: String, enum: Object.values(OUTBOX_STATUS), default: OUTBOX_STATUS.PENDING },
    publishAttempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    nextAttemptAt: { type: Date, default: Date.now },
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    // Number of times this event was confirmed by RabbitMQ (>1 means it was published more than once).
    publishCount: { type: Number, default: 0 },
    // 'application' or 'generator' (Stage 3 synthetic event generator).
    source: { type: String, default: 'application' },
    isTestEvent: { type: Boolean, default: false },
    testBatchId: { type: String, default: null },
  },
  { timestamps: true, minimize: false }
);

outboxEventSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
outboxEventSchema.index({ status: 1, claimedAt: 1 });
outboxEventSchema.index({ aggregateId: 1, createdAt: 1 });
outboxEventSchema.index({ correlationId: 1 });
outboxEventSchema.index({ isTestEvent: 1, testBatchId: 1 });

outboxEventSchema.plugin(toJSONPlugin);

export const OutboxEvent =
  mongoose.models.OutboxEvent || mongoose.model('OutboxEvent', outboxEventSchema, 'outbox_events');
