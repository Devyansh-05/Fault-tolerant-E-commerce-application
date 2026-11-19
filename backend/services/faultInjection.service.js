import { config } from '../config/env.js';
import { APPLY_TO, FAULT_TYPES } from '../fault-injection/faultDefinitions.js';
import * as store from '../fault-injection/faultStore.js';
import { AppError } from '../utils/AppError.js';
import { retryPolicy } from '../reliable-event-processor/retryEngine.js';
import { logger } from '../utils/logger.js';

/** Current configuration plus everything the Testing Panel needs to render its form. */
export async function getFaultOverview() {
  const faults = await store.listFaults();
  return {
    available: config.faultInjection.enabled,
    faults,
    activeCount: faults.filter((f) => f.active).length,
    definitions: Object.entries(FAULT_TYPES).map(([faultType, d]) => ({
      faultType,
      label: d.label,
      kind: d.kind,
      consumers: d.consumers,
      params: d.params,
      description: d.description,
    })),
    applyToOptions: Object.values(APPLY_TO),
    limits: {
      maxDelayMs: config.faultInjection.maxDelayMs,
      maxFailureCount: config.faultInjection.maxFailureCount,
      maxDuplicateCopies: config.faultInjection.maxDuplicateCopies,
      processingTimeoutMs: config.events.processingTimeoutMs,
      maxGeneratedEvents: config.testing.maxGeneratedEvents,
    },
    retryPolicy: retryPolicy(),
  };
}

export async function enableFault(definition, admin) {
  const fault = await store.saveFault(definition, admin.email);
  logger.warn(`[fault] ENABLED ${fault.faultType} on ${fault.targetConsumer} by ${admin.email} ${JSON.stringify({ failureRate: fault.failureRate, failureCount: fault.failureCount, delayMs: fault.delayMs, copies: fault.copies, applyTo: fault.applyTo })}`);
  return fault;
}

export async function disableFault({ all, faultType, targetConsumer }, admin) {
  if (all) {
    const disabled = await store.disableAllFaults();
    logger.warn(`[fault] all faults disabled by ${admin.email} (${disabled} were enabled)`);
    return { disabled };
  }
  const fault = await store.disableFault(faultType, targetConsumer);
  if (!fault) throw new AppError(404, 'FAULT_NOT_FOUND', `${faultType} on ${targetConsumer} has never been configured`);
  logger.warn(`[fault] DISABLED ${faultType} on ${targetConsumer} by ${admin.email}`);
  return { disabled: 1, fault };
}
