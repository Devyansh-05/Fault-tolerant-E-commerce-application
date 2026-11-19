import { Cart, Product, MAX_QUANTITY_PER_ITEM } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { multiplyPrice, sumAmounts, CURRENCY } from '../utils/money.js';

/**
 * Builds the cart view. Prices and availability always come from the Product
 * collection at read time — the cart only stores product IDs and quantities.
 */
async function buildCartView(cart) {
  const items = cart?.items ?? [];
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const viewItems = items.map((item) => {
    const product = byId.get(String(item.productId));
    const isAvailable = Boolean(product?.isActive) && product.stock >= item.quantity;
    return {
      productId: String(item.productId),
      name: product?.name ?? 'Unavailable product',
      image: product?.image ?? '',
      category: product?.category ?? '',
      unitPrice: product?.price ?? 0,
      quantity: item.quantity,
      lineTotal: product ? multiplyPrice(product.price, item.quantity) : 0,
      availableStock: product?.isActive ? product.stock : 0,
      isAvailable,
    };
  });

  return {
    items: viewItems,
    itemCount: viewItems.reduce((n, i) => n + i.quantity, 0),
    subtotal: sumAmounts(viewItems.filter((i) => i.isAvailable).map((i) => i.lineTotal)),
    currency: CURRENCY,
    hasUnavailableItems: viewItems.some((i) => !i.isAvailable),
    updatedAt: cart?.updatedAt ?? null,
  };
}

async function getActiveProductOrThrow(productId) {
  const product = await Product.findOne({ _id: productId, isActive: true });
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  return product;
}

function assertStock(product, quantity) {
  if (quantity > MAX_QUANTITY_PER_ITEM) {
    throw new AppError(422, 'QUANTITY_LIMIT', `You can add at most ${MAX_QUANTITY_PER_ITEM} units of one product`);
  }
  if (quantity > product.stock) {
    throw new AppError(
      422,
      'INSUFFICIENT_STOCK',
      product.stock === 0 ? `"${product.name}" is out of stock` : `Only ${product.stock} unit(s) of "${product.name}" available`,
      { details: { productId: product.id, available: product.stock } }
    );
  }
}

export async function getCart(userId) {
  return buildCartView(await Cart.findOne({ userId }));
}

export async function addItem(userId, { productId, quantity }) {
  const product = await getActiveProductOrThrow(productId);
  const cart = (await Cart.findOne({ userId })) ?? new Cart({ userId, items: [] });

  const existing = cart.items.find((i) => String(i.productId) === productId);
  const newQuantity = (existing?.quantity ?? 0) + quantity;
  assertStock(product, newQuantity);

  if (existing) existing.quantity = newQuantity;
  else cart.items.push({ productId, quantity });
  await cart.save();
  return buildCartView(cart);
}

export async function updateItem(userId, { productId, quantity }) {
  const cart = await Cart.findOne({ userId });
  const existing = cart?.items.find((i) => String(i.productId) === productId);
  if (!existing) throw new AppError(404, 'CART_ITEM_NOT_FOUND', 'This product is not in your cart');

  assertStock(await getActiveProductOrThrow(productId), quantity);
  existing.quantity = quantity;
  await cart.save();
  return buildCartView(cart);
}

export async function removeItem(userId, productId) {
  const cart = await Cart.findOneAndUpdate({ userId }, { $pull: { items: { productId } } }, { new: true });
  return buildCartView(cart);
}

export async function clearCart(userId) {
  const cart = await Cart.findOneAndUpdate({ userId }, { $set: { items: [] } }, { new: true });
  return buildCartView(cart);
}

/** Removes purchased products from the cart; called inside the order transaction. */
export async function removePurchasedItems(userId, productIds, session) {
  await Cart.updateOne({ userId }, { $pull: { items: { productId: { $in: productIds } } } }, { session });
}
