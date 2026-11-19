import { z } from 'zod';
import { objectId } from './common.js';
import { MAX_QUANTITY_PER_ITEM } from '../models/Cart.js';

const quantity = z
  .number({ invalid_type_error: 'Quantity must be a number' })
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(MAX_QUANTITY_PER_ITEM, `Quantity cannot exceed ${MAX_QUANTITY_PER_ITEM}`);

export const addToCartSchema = z.object({ productId: objectId, quantity: quantity.default(1) });
export const updateCartSchema = z.object({ productId: objectId, quantity });
