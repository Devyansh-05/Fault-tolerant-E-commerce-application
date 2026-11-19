/**
 * Fault catalogue — the explicit allowlist of fault types, their target consumers and which
 * parameters each one accepts. Shared by validation, the store and the injector.
 *
 * Parameters (all optional unless noted; validated against config.faultInjection limits):
 *   failureRate   1..100   % chance that a matching attempt is affected (default 100)
 *   failureCount  1..N     number of affected attempts/events, then the fault is exhausted
 *                          (null/omitted = unlimited while enabled)
 *   delayMs       ARTIFICIAL_DELAY only (required)
 *   copies        DUPLICATE_DELIVERY only: extra copies delivered per processed event
 *   applyTo       ALL | TEST_EVENTS | REAL_EVENTS (default ALL)
 */
import { CONSUMER_NAMES } from '../messaging/topology.js';

const ALL_CONSUMERS = Object.values(CONSUMER_NAMES);

export const FAULT_TYPES = Object.freeze({
  PAYMENT_FAILURE: {
    label: 'Payment Failure',
    kind: 'FAILURE',
    consumers: [CONSUMER_NAMES.PAYMENT],
    params: ['failureRate', 'failureCount'],
    description: 'The Payment Consumer throws a simulated transient error -> retry, or DLQ when retries are exhausted.',
  },
  INVENTORY_FAILURE: {
    label: 'Inventory Failure',
    kind: 'FAILURE',
    consumers: [CONSUMER_NAMES.INVENTORY],
    params: ['failureRate', 'failureCount'],
    description: 'The Inventory Consumer throws a simulated transient error before reserving stock.',
  },
  EMAIL_FAILURE: {
    label: 'Email Failure',
    kind: 'FAILURE',
    consumers: [CONSUMER_NAMES.EMAIL],
    params: ['failureRate', 'failureCount'],
    description: 'The Email Consumer throws a simulated "SMTP unavailable" error.',
  },
  ARTIFICIAL_DELAY: {
    label: 'Artificial Delay / Timeout',
    kind: 'DELAY',
    consumers: ALL_CONSUMERS,
    params: ['delayMs', 'failureRate', 'failureCount'],
    description: 'Delays processing in the selected consumer. Delays above the processing timeout become timeout failures.',
  },
  DUPLICATE_DELIVERY: {
    label: 'Duplicate Event Delivery',
    kind: 'DUPLICATE',
    consumers: ALL_CONSUMERS,
    params: ['copies', 'failureRate', 'failureCount'],
    description: 'After an event is processed, the SAME message (same eventId) is delivered again to the consumer.',
  },
  PERSISTENT_FAILURE: {
    label: 'Repeated / Persistent Failure',
    kind: 'FAILURE',
    consumers: ALL_CONSUMERS,
    params: ['failureCount'],
    description: 'Every attempt in the selected consumer fails (for the next N attempts, or always) -> retry exhaustion and DLQ.',
  },
});

export const APPLY_TO = Object.freeze({ ALL: 'ALL', TEST_EVENTS: 'TEST_EVENTS', REAL_EVENTS: 'REAL_EVENTS' });

export const FAULT_TYPE_NAMES = Object.keys(FAULT_TYPES);

/** Fault types that can affect a given consumer (used by the injector to look them up). */
export const faultTypesForConsumer = (consumer) =>
  FAULT_TYPE_NAMES.filter((type) => FAULT_TYPES[type].consumers.includes(consumer));
