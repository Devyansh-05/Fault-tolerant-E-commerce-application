import { z } from 'zod';
import { paginationQuery } from './common.js';
import { hasAtMostTwoDecimals } from '../utils/money.js';

const price = z
  .number({ invalid_type_error: 'Price must be a number' })
  .min(0)
  .max(10_000_000)
  .refine(hasAtMostTwoDecimals, 'Price may have at most 2 decimal places');

const image = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || v.startsWith('/') || /^https?:\/\//i.test(v), 'Image must be a URL or an absolute path');

export const createProductSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).default(''),
  price,
  category: z.string().trim().min(2).max(60),
  image: image.default(''),
  stock: z.number().int().min(0).max(1_000_000),
});

export const updateProductSchema = createProductSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, 'Provide at least one field to update');

export const listProductsQuery = z
  .object({
    ...paginationQuery,
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(60).optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'name']).default('newest'),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice cannot be greater than maxPrice',
    path: ['minPrice'],
  });
