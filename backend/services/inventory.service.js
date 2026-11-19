/**
 * Inventory operations. Inventory is the source of truth for stock; Product.stock mirrors
 * availableQuantity and is updated in the SAME session/transaction.
 *
 * Stage 2 flow:
 *   checkout transaction -> assertAvailable()          (check only, no deduction)
 *   Inventory Consumer   -> reserveForOrder()          (available -> reserved, once per order)
 *   Order saga           -> commitReservation()        (confirmed: reserved stock is sold)
 *                        -> releaseReservation()       (failed: reserved -> available)
 *
 * Duplicate-deduction protection: one InventoryReservation per order (unique orderId) plus
 * conditional status transitions; stock changes use atomic conditional $inc updates.
 */
import { Inventory, InventoryReservation, Product, RESERVATION_STATUS } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { TransientError } from '../reliable-event-processor/errors.js';

async function syncProductStock(productId, session) {
  const inventory = await Inventory.findOne({ productId }).session(session);
  await Product.updateOne({ _id: productId }, { $set: { stock: inventory?.availableQuantity ?? 0 } }, { session });
}

/** Checkout-time availability check (no deduction). Throws 422 INSUFFICIENT_STOCK. */
export async function assertAvailable(items, session) {
  const inventories = await Inventory.find({ productId: { $in: items.map((i) => i.productId) } }).session(session);
  const byId = new Map(inventories.map((inv) => [String(inv.productId), inv]));
  for (const { productId, quantity, name } of items) {
    const available = byId.get(String(productId))?.availableQuantity ?? 0;
    if (available < quantity) {
      throw new AppError(
        422,
        'INSUFFICIENT_STOCK',
        `Not enough stock for "${name ?? productId}". Requested ${quantity}, available ${available}.`,
        { details: { productId: String(productId), requested: quantity, available } }
      );
    }
  }
}

/**
 * Reserves stock for an order exactly once (Inventory Consumer, inside its transaction).
 * @returns {{ outcome: 'RESERVED'|'FAILED'|'ALREADY_PROCESSED', reservation, shortages? }}
 */
export async function reserveForOrder(orderId, items, eventId, session) {
  const existing = await InventoryReservation.findOne({ orderId }).session(session);
  if (existing) return { outcome: 'ALREADY_PROCESSED', reservation: existing };

  // Check everything first: either the whole order is reserved or nothing is.
  const inventories = await Inventory.find({ productId: { $in: items.map((i) => i.productId) } }).session(session);
  const byId = new Map(inventories.map((inv) => [String(inv.productId), inv]));
  const shortages = items
    .map(({ productId, quantity, name }) => ({
      productId: String(productId),
      name: name ?? '',
      requested: quantity,
      available: byId.get(String(productId))?.availableQuantity ?? 0,
    }))
    .filter((s) => s.available < s.requested);

  if (shortages.length > 0) {
    const [reservation] = await InventoryReservation.create(
      [{ orderId, items: [], status: RESERVATION_STATUS.FAILED, reason: 'Insufficient stock', eventId }],
      { session }
    );
    return { outcome: 'FAILED', reservation, shortages };
  }

  for (const { productId, quantity } of items) {
    const updated = await Inventory.findOneAndUpdate(
      { productId, availableQuantity: { $gte: quantity } },
      { $inc: { availableQuantity: -quantity, reservedQuantity: quantity } },
      { new: true, session }
    );
    // Stock changed between the check and the update: retry the whole transaction/event.
    if (!updated) throw new TransientError(`Stock for product ${productId} changed concurrently`);
    await syncProductStock(productId, session);
  }

  const [reservation] = await InventoryReservation.create(
    [{ orderId, items: items.map(({ productId, quantity }) => ({ productId, quantity })), status: RESERVATION_STATUS.RESERVED, eventId }],
    { session }
  );
  return { outcome: 'RESERVED', reservation };
}

/** Order confirmed: the reserved units are sold (reserved -> gone). Idempotent. */
export async function commitReservation(orderId, session) {
  const reservation = await InventoryReservation.findOneAndUpdate(
    { orderId, status: RESERVATION_STATUS.RESERVED },
    { $set: { status: RESERVATION_STATUS.COMMITTED } },
    { new: true, session }
  );
  if (!reservation) return false;
  for (const { productId, quantity } of reservation.items) {
    await Inventory.updateOne({ productId }, { $inc: { reservedQuantity: -quantity } }, { session });
  }
  return true;
}

/** Compensation: returns reserved units to available stock. Idempotent. */
export async function releaseReservation(orderId, session) {
  const reservation = await InventoryReservation.findOneAndUpdate(
    { orderId, status: RESERVATION_STATUS.RESERVED },
    { $set: { status: RESERVATION_STATUS.RELEASED, reason: 'Order failed — stock released' } },
    { new: true, session }
  );
  if (!reservation) return false;
  for (const { productId, quantity } of reservation.items) {
    await Inventory.updateOne({ productId }, { $inc: { availableQuantity: quantity, reservedQuantity: -quantity } }, { session });
    await syncProductStock(productId, session);
  }
  return true;
}

/** Creates the inventory record for a new product. */
export async function createInventory(productId, availableQuantity, session) {
  const [inventory] = await Inventory.create([{ productId, availableQuantity, reservedQuantity: 0 }], { session });
  return inventory;
}

/** Admin stock correction: sets the available quantity to an absolute value. */
export async function setAvailableQuantity(productId, availableQuantity, session) {
  await Inventory.updateOne(
    { productId },
    { $set: { availableQuantity }, $setOnInsert: { reservedQuantity: 0 } },
    { upsert: true, session }
  );
  await Product.updateOne({ _id: productId }, { $set: { stock: availableQuantity } }, { session });
}

export async function getAvailableQuantity(productId) {
  const inventory = await Inventory.findOne({ productId }).lean();
  return inventory?.availableQuantity ?? 0;
}
