import { z } from 'zod';

export const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Must be a valid id')
  .transform((id) => id.toLowerCase());

export const idParams = z.object({ id: objectId });
export const productIdParams = z.object({ productId: objectId });

export const paginationQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
};
