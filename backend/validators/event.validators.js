import { z } from 'zod';
import { paginationQuery } from './common.js';
import { EVENT_STATUS, OUTBOX_STATUS } from '../models/index.js';
import { EVENT_TYPES } from '../events/eventTypes.js';
import { CONSUMER_BINDINGS } from '../messaging/topology.js';

const consumer = z.enum(Object.keys(CONSUMER_BINDINGS));
const page = { ...paginationQuery, limit: paginationQuery.limit.default(20) };

/** all = everything, test = synthetic generator events only, real = application events only. */
const scope = z.enum(['all', 'test', 'real']).default('all');
const batchId = z.string().trim().max(100).optional();
const date = z.coerce.date().optional();

export const statsQuery = z.object({ scope, batchId });

export const listEventsQuery = z
  .object({
    ...page,
    status: z.enum(Object.values(EVENT_STATUS)).optional(),
    consumer: consumer.optional(),
    eventType: z.enum(Object.values(EVENT_TYPES)).optional(),
    correlationId: z.string().trim().max(100).optional(),
    q: z.string().trim().max(100).optional(),
    scope,
    batchId,
    from: date,
    to: date,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '"from" must be before "to"', path: ['from'] });

export const dlqQuery = z.object({ ...page, consumer: consumer.optional(), scope });

export const outboxQuery = z.object({
  ...page,
  status: z.enum(Object.values(OUTBOX_STATUS)).optional(),
  eventType: z.enum(Object.values(EVENT_TYPES)).optional(),
  scope,
});

export const eventIdParams = z.object({ eventId: z.string().trim().min(1).max(100) });
