import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';
import { CURRENCY } from '../utils/money.js';

export const PAYMENT_RECORD_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
});

/**
 * Simulated payment record. No real money is processed.
 *
 * `paymentReference` is derived deterministically from the order ID and is unique,
 * so a retried payment for the same order can never create a second charge.
 * Stage 2's Payment Consumer relies on this property.
 */
const paymentSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: CURRENCY },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_RECORD_STATUS),
      default: PAYMENT_RECORD_STATUS.PENDING,
    },
    paymentReference: { type: String, required: true, unique: true },
    method: { type: String, default: 'SIMULATED' },
    gatewayTransactionId: { type: String, default: '' },
    failureReason: { type: String, default: '' },
    processedAt: { type: Date, default: null },
    processedByEventId: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    refundReference: { type: String, default: null },
    isTest: { type: Boolean, default: false },
  },
  { timestamps: true }
);

paymentSchema.plugin(toJSONPlugin);

export const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
