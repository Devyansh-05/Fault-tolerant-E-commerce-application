import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';

/**
 * One stock reservation per order (unique orderId). This is the business-level guard
 * against duplicate inventory deductions, and records what must be released on compensation.
 *
 * RESERVED  -> stock moved from available to reserved
 * COMMITTED -> order confirmed; reserved stock is consumed (sold)
 * RELEASED  -> order failed; reserved stock returned to available
 * FAILED    -> not enough stock; nothing was reserved
 */
export const RESERVATION_STATUS = Object.freeze({
  RESERVED: 'RESERVED',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
  FAILED: 'FAILED',
});

const reservationSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    items: {
      type: [
        new mongoose.Schema(
          { productId: { type: mongoose.Schema.Types.ObjectId, required: true }, quantity: { type: Number, required: true } },
          { _id: false }
        ),
      ],
      default: [],
    },
    status: { type: String, enum: Object.values(RESERVATION_STATUS), required: true },
    reason: { type: String, default: '' },
    eventId: { type: String, required: true },
  },
  { timestamps: true }
);

reservationSchema.plugin(toJSONPlugin);

export const InventoryReservation =
  mongoose.models.InventoryReservation ||
  mongoose.model('InventoryReservation', reservationSchema, 'inventory_reservations');
