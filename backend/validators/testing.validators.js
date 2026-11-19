import { z } from 'zod';
import { config } from '../config/env.js';
import { APPLY_TO, FAULT_TYPE_NAMES, FAULT_TYPES } from '../fault-injection/faultDefinitions.js';
import { CONSUMER_NAMES } from '../messaging/topology.js';

const consumer = z.enum(Object.values(CONSUMER_NAMES));
const limits = config.faultInjection;

/**
 * Fault configuration. Only the parameters that belong to the selected fault type are kept
 * (see FAULT_TYPES[...].params); everything is range-checked against configured limits.
 */
export const enableFaultSchema = z
  .object({
    faultType: z.enum(FAULT_TYPE_NAMES),
    targetConsumer: consumer,
    failureRate: z.number().int().min(1).max(100).optional(),
    failureCount: z.number().int().min(1).max(limits.maxFailureCount).nullable().optional(),
    delayMs: z.number().int().min(100).max(limits.maxDelayMs).optional(),
    copies: z.number().int().min(1).max(limits.maxDuplicateCopies).optional(),
    applyTo: z.enum(Object.values(APPLY_TO)).default(APPLY_TO.ALL),
  })
  .superRefine((value, ctx) => {
    const definition = FAULT_TYPES[value.faultType];
    if (!definition.consumers.includes(value.targetConsumer)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetConsumer'],
        message: `${value.faultType} can only target: ${definition.consumers.join(', ')}`,
      });
    }
    if (definition.kind === 'DELAY' && value.delayMs === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delayMs'], message: 'delayMs is required for ARTIFICIAL_DELAY' });
    }
  })
  .transform((value) => {
    const allowed = new Set(FAULT_TYPES[value.faultType].params);
    return {
      faultType: value.faultType,
      targetConsumer: value.targetConsumer,
      applyTo: value.applyTo,
      failureRate: allowed.has('failureRate') ? value.failureRate ?? 100 : 100,
      failureCount: allowed.has('failureCount') ? value.failureCount ?? null : null,
      delayMs: allowed.has('delayMs') ? value.delayMs : 0,
      copies: allowed.has('copies') ? value.copies ?? 1 : 0,
    };
  });

export const disableFaultSchema = z
  .object({
    all: z.boolean().optional(),
    faultType: z.enum(FAULT_TYPE_NAMES).optional(),
    targetConsumer: consumer.optional(),
  })
  .refine((v) => v.all === true || (v.faultType && v.targetConsumer), {
    message: 'Provide faultType and targetConsumer, or all: true',
  });

export const GENERATED_EVENT_TYPES = Object.freeze({
  TEST_ORDER_EVENT: 'TEST_ORDER_EVENT', // full saga: ORDER_CREATED -> payment + inventory -> order -> email
  TEST_EMAIL_EVENT: 'TEST_EMAIL_EVENT', // EMAIL_NOTIFICATION_REQUESTED -> email consumer only
});

export const generateEventsSchema = z.object({
  count: z.number().int().min(1).max(config.testing.maxGeneratedEvents),
  eventType: z.enum(Object.values(GENERATED_EVENT_TYPES)).default(GENERATED_EVENT_TYPES.TEST_ORDER_EVENT),
});

export const duplicateDeliverySchema = z.object({
  eventId: z.string().trim().min(8).max(100),
  copies: z.number().int().min(1).max(10).default(1),
  consumer: consumer.optional(),
});

export const replaySchema = z.object({ consumer });
