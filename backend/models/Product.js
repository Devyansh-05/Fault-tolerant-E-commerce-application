import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';
import { hasAtMostTwoDecimals } from '../utils/money.js';
import { slugify } from '../utils/helpers.js';

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    // Unique, URL-friendly identifier. Also lets the seed script upsert without duplicates.
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    price: {
      type: Number,
      required: true,
      min: 0,
      max: 10_000_000,
      validate: { validator: hasAtMostTwoDecimals, message: 'Price may have at most 2 decimal places' },
    },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    image: { type: String, trim: true, maxlength: 500, default: '' },
    /**
     * Denormalised copy of Inventory.availableQuantity, used for fast catalogue reads.
     * The Inventory collection is the source of truth; inventory.service keeps both
     * in sync inside the same transaction.
     */
    stock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: { validator: Number.isInteger, message: 'Stock must be an integer' },
    },
    // Soft delete: historical orders keep referencing the product.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ isActive: 1, category: 1 });
productSchema.index({ isActive: 1, price: 1 });
productSchema.index({ isActive: 1, createdAt: -1 });

productSchema.pre('validate', function setSlug(next) {
  if (!this.slug && this.name) this.slug = slugify(this.name);
  next();
});

productSchema.plugin(toJSONPlugin);

export const Product = mongoose.models.Product || mongoose.model('Product', productSchema);
