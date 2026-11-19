import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';

const nonNegativeInteger = {
  type: Number,
  required: true,
  min: 0,
  default: 0,
  validate: { validator: Number.isInteger, message: '{PATH} must be an integer' },
};

/**
 * Source of truth for stock levels.
 * - availableQuantity: units that can still be sold.
 * - reservedQuantity:  units held for orders that are not yet final.
 *   (Stage 1 deducts stock synchronously, so this stays 0; Stage 2's Inventory
 *   Consumer will use reservations.)
 */
const inventorySchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, unique: true },
    availableQuantity: nonNegativeInteger,
    reservedQuantity: nonNegativeInteger,
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

inventorySchema.plugin(toJSONPlugin);

export const Inventory = mongoose.models.Inventory || mongoose.model('Inventory', inventorySchema, 'inventory');
