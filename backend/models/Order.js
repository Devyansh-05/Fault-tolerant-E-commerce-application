import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';
import { CURRENCY } from '../utils/money.js';

/**
 * Order lifecycle (Stage 2, event driven):
 *   PENDING     order + outbox event committed; nothing processed yet
 *   PROCESSING  at least one of payment / inventory has reported a result
 *   CONFIRMED   payment SUCCEEDED and inventory RESERVED
 *   PAYMENT_FAILED / INVENTORY_FAILED  terminal failure (with compensation if needed)
 *   CANCELLED / FAILED  reserved for manual/administrative outcomes
 */
export const ORDER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  CONFIRMED: 'CONFIRMED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INVENTORY_FAILED: 'INVENTORY_FAILED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});

export const TERMINAL_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.PAYMENT_FAILED,
  ORDER_STATUS.INVENTORY_FAILED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.FAILED,
]);

/** Per-step results reported by the payment and inventory consumers. */
export const STEP_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED', // payment
  RESERVED: 'RESERVED', // inventory
  FAILED: 'FAILED',
});

export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
});

// Embedded order items: a price/name snapshot taken at purchase time from the DB.
const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    image: { type: String, default: '' },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    addressLine1: { type: String, required: true, trim: true },
    addressLine2: { type: String, trim: true, default: '' },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    postalCode: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    note: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    orderItems: {
      type: [orderItemSchema],
      validate: { validator: (items) => items.length > 0, message: 'An order needs at least one item' },
    },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: CURRENCY },
    shippingAddress: { type: shippingAddressSchema, required: true },
    orderStatus: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING },
    paymentStatus: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    paymentReference: { type: String },

    /**
     * HTTP idempotency — durable layer.
     * Redis provides fast duplicate detection, but Redis is not the only guard:
     * the unique (userId, idempotencyKey) index guarantees at most one order per key
     * even if Redis loses its data or a processing lock expires mid-request.
     * The fingerprint lets us detect key reuse with a different payload after Redis expiry.
     */
    idempotencyKey: { type: String, required: true },
    requestFingerprint: { type: String, required: true },

    statusHistory: { type: [statusHistorySchema], default: [] },

    // Results of the asynchronous saga steps (order of arrival is not assumed).
    fulfillment: {
      payment: {
        status: { type: String, enum: Object.values(STEP_STATUS), default: STEP_STATUS.PENDING },
        reason: { type: String, default: '' },
        eventId: { type: String, default: null },
        updatedAt: { type: Date, default: null },
      },
      inventory: {
        status: { type: String, enum: Object.values(STEP_STATUS), default: STEP_STATUS.PENDING },
        reason: { type: String, default: '' },
        eventId: { type: String, default: null },
        updatedAt: { type: Date, default: null },
      },
    },
    failureReason: { type: String, default: '' },
    compensation: {
      paymentRefunded: { type: Boolean, default: false },
      stockReleased: { type: Boolean, default: false },
    },

    // Synthetic orders created by the Stage 3 event generator (synthetic user + products).
    // They are excluded from business statistics and never touch real customer data.
    isTest: { type: Boolean, default: false },
    testBatchId: { type: String, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, name: 'uniq_user_idempotency_key' });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

orderSchema.plugin(toJSONPlugin, { hidden: ['requestFingerprint'] });

export const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
