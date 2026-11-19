import { z } from 'zod';
import { objectId, paginationQuery } from './common.js';
import { MAX_QUANTITY_PER_ITEM } from '../models/Cart.js';

const text = (min, max) => z.string().trim().min(min).max(max);

export const shippingAddressSchema = z.object({
  fullName: text(2, 80),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'),
  addressLine1: text(3, 120),
  addressLine2: z.string().trim().max(120).default(''),
  city: text(2, 60),
  state: text(2, 60),
  postalCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9\s-]{3,12}$/, 'Enter a valid postal code'),
  country: text(2, 60),
});

/**
 * Order creation payload. Clients send ONLY product IDs and quantities —
 * any price fields are stripped; totals are always computed from MongoDB.
 * Items are sorted by productId so that the request fingerprint does not depend on
 * the order in which the client listed them.
 */
export const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: objectId,
        quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_ITEM),
      })
    )
    .min(1, 'An order must contain at least one item')
    .max(50)
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, 'Duplicate products in items')
    .transform((items) => [...items].sort((a, b) => a.productId.localeCompare(b.productId))),
  shippingAddress: shippingAddressSchema,
});

export const listOrdersQuery = z.object({ ...paginationQuery, limit: paginationQuery.limit.default(10) });
