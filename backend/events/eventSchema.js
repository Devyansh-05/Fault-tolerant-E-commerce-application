/**
 * Event envelope + payload validation. A message that fails validation is a PERMANENT
 * failure: retrying cannot fix it, so it goes straight to the DLQ.
 */
import { z } from 'zod';
import { EVENT_TYPES } from './eventTypes.js';

const objectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const envelopeSchema = z.object({
  eventId: z.string().min(8).max(100),
  eventType: z.enum(Object.values(EVENT_TYPES)),
  eventVersion: z.number().int().min(1),
  aggregateType: z.string().min(1).max(40),
  aggregateId: z.string().min(1).max(100),
  correlationId: z.string().min(1).max(100).optional(),
  causationId: z.string().max(100).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
  // Optional, propagated to every follow-up event. Marks synthetic (Stage 3 generator) events.
  metadata: z
    .object({
      isTestEvent: z.boolean().optional(),
      testBatchId: z.string().max(100).optional(),
      source: z.string().max(40).optional(),
    })
    .optional(),
});

const item = z.object({ productId: objectIdString, quantity: z.number().int().min(1), name: z.string().optional() });
const customer = z.object({ userId: objectIdString, name: z.string(), email: z.string().email() });

const orderRef = { orderId: objectIdString, orderNumber: z.string().optional() };

const PAYLOAD_SCHEMAS = {
  [EVENT_TYPES.ORDER_CREATED]: z.object({
    ...orderRef,
    userId: objectIdString,
    totalAmount: z.number().min(0),
    currency: z.string(),
    paymentReference: z.string(),
    items: z.array(item).min(1),
  }),
  [EVENT_TYPES.PAYMENT_COMPLETED]: z.object({ ...orderRef, paymentReference: z.string(), amount: z.number(), gatewayTransactionId: z.string() }),
  [EVENT_TYPES.PAYMENT_FAILED]: z.object({ ...orderRef, paymentReference: z.string(), amount: z.number(), reason: z.string() }),
  [EVENT_TYPES.INVENTORY_RESERVED]: z.object({ ...orderRef, items: z.array(item).min(1) }),
  [EVENT_TYPES.INVENTORY_FAILED]: z.object({ ...orderRef, reason: z.string(), shortages: z.array(z.record(z.unknown())).optional() }),
  [EVENT_TYPES.ORDER_CONFIRMED]: z.object({ ...orderRef, totalAmount: z.number(), customer }),
  [EVENT_TYPES.ORDER_FAILED]: z.object({
    ...orderRef,
    orderStatus: z.string(),
    reason: z.string(),
    totalAmount: z.number(),
    customer,
    compensation: z.object({ paymentRefunded: z.boolean(), stockReleased: z.boolean() }),
  }),
  [EVENT_TYPES.EMAIL_NOTIFICATION_REQUESTED]: z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().max(5000),
    orderId: objectIdString.optional(),
    template: z.string().max(60).optional(),
  }),
};

/**
 * Validates an envelope and its type-specific payload.
 * @returns {{ success: true, event } | { success: false, error: string }}
 */
export function validateEvent(candidate) {
  const envelope = envelopeSchema.safeParse(candidate);
  if (!envelope.success) {
    return { success: false, error: `Invalid event envelope: ${formatIssues(envelope.error)}` };
  }
  const payloadSchema = PAYLOAD_SCHEMAS[envelope.data.eventType];
  const payload = payloadSchema.safeParse(envelope.data.payload);
  if (!payload.success) {
    return { success: false, error: `Invalid ${envelope.data.eventType} payload: ${formatIssues(payload.error)}` };
  }
  return { success: true, event: { ...envelope.data, payload: payload.data } };
}

function formatIssues(error) {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ');
}
