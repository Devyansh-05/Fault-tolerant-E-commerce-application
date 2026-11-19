import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';

/**
 * Simulated e-mail notifications (no external e-mail service is contacted).
 * The unique `eventId` guarantees that one event can produce at most one notification,
 * even if it is delivered many times.
 */
const notificationSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    channel: { type: String, default: 'EMAIL' },
    template: { type: String, required: true }, // ORDER_CONFIRMED | ORDER_FAILED | CUSTOM
    to: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, enum: ['SENT', 'FAILED'], default: 'SENT' },
    providerMessageId: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

notificationSchema.index({ orderId: 1 });
notificationSchema.index({ createdAt: -1 });
notificationSchema.plugin(toJSONPlugin);

export const Notification =
  mongoose.models.Notification || mongoose.model('Notification', notificationSchema, 'notifications');
