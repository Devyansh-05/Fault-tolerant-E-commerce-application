import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';

export const MAX_QUANTITY_PER_ITEM = 20;

const cartItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_QUANTITY_PER_ITEM,
      validate: { validator: Number.isInteger, message: 'Quantity must be an integer' },
    },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// One cart per user. Prices are intentionally NOT stored — they are always read from Product.
const cartSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
  },
  { timestamps: true }
);

cartSchema.plugin(toJSONPlugin);

export const Cart = mongoose.models.Cart || mongoose.model('Cart', cartSchema);
