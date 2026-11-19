import { Product } from '../models/index.js';
import { runInTransaction } from '../config/database.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex, paginate, slugify } from '../utils/helpers.js';
import { createInventory, setAvailableQuantity } from './inventory.service.js';

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  name: { name: 1, _id: 1 },
};

export async function listProducts({ q, category, page, limit, sort, minPrice, maxPrice }) {
  const filter = { isActive: true };
  if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: pattern }, { description: pattern }, { category: pattern }];
  }
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) filter.price.$gte = minPrice;
    if (maxPrice !== undefined) filter.price.$lte = maxPrice;
  }

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort(SORTS[sort] ?? SORTS.newest)
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter),
  ]);

  return { products: products.map((p) => p.toJSON()), pagination: paginate({ page, limit, total }) };
}

export async function listCategories() {
  const categories = await Product.distinct('category', { isActive: true });
  return categories.sort((a, b) => a.localeCompare(b));
}

export async function getProductById(id) {
  const product = await Product.findOne({ _id: id, isActive: true });
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  return product.toJSON();
}

async function assertSlugAvailable(slug, excludeId) {
  const clash = await Product.exists({ slug, ...(excludeId && { _id: { $ne: excludeId } }) });
  if (clash) throw new AppError(409, 'PRODUCT_EXISTS', 'A product with this name already exists');
}

/** Product + its Inventory record are created atomically. */
export async function createProduct(data) {
  const slug = slugify(data.name);
  await assertSlugAvailable(slug);

  const product = await runInTransaction(async (session) => {
    const [created] = await Product.create([{ ...data, slug }], { session });
    await createInventory(created._id, data.stock, session);
    return created;
  });
  return product.toJSON();
}

export async function updateProduct(id, data) {
  const existing = await Product.findOne({ _id: id, isActive: true });
  if (!existing) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');

  const { stock, ...fields } = data;
  if (fields.name) {
    fields.slug = slugify(fields.name);
    await assertSlugAvailable(fields.slug, id);
  }

  await runInTransaction(async (session) => {
    if (Object.keys(fields).length > 0) {
      await Product.updateOne({ _id: id }, { $set: fields }, { session, runValidators: true });
    }
    if (stock !== undefined) await setAvailableQuantity(id, stock, session);
  });

  return (await Product.findById(id)).toJSON();
}

/** Soft delete: the product disappears from the catalogue but past orders stay intact. */
export async function deleteProduct(id) {
  const result = await Product.updateOne({ _id: id, isActive: true }, { $set: { isActive: false } });
  if (result.matchedCount === 0) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
}
