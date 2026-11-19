/**
 * Fault Injector — installs the Reliable Event Processor hooks in the WORKER process.
 *
 * beforeHandle (every processing attempt, inside the attempt's timeout):
 *   1. ARTIFICIAL_DELAY   -> abortable wait (the processor's AbortSignal cancels it on timeout,
 *                            so a timed-out attempt never continues into its business logic)
 *   2. *_FAILURE / PERSISTENT_FAILURE -> throw TransientError("[FAULT INJECTION] ...")
 *      The real processor then records FAILED, schedules a retry with back-off, or moves the
 *      event to the DLQ when the retry budget is exhausted — exactly as for a real outage.
 *
 * afterSuccess (after an event COMPLETED and was acked):
 *   3. DUPLICATE_DELIVERY -> re-delivers the SAME message (same eventId, same body) N times to
 *      that consumer's queue. Event idempotency must detect every copy as a DUPLICATE.
 *
 * Nothing here changes a status directly; outcomes are decided by the real pipeline.
 * Not installed when fault injection is disabled (always disabled in production).
 */
import { config } from '../config/env.js';
import { publishConfirmed } from '../config/rabbitmq.js';
import { mainQueueName } from '../messaging/topology.js';
import { setAfterSuccessHook, setBeforeHandleHook } from '../reliable-event-processor/hooks.js';
import { TransientError } from '../reliable-event-processor/errors.js';
import { logger } from '../utils/logger.js';
import { APPLY_TO, FAULT_TYPES } from './faultDefinitions.js';
import { getEnabledFaultsForConsumer, tryTrigger } from './faultStore.js';

const SIMULATED_DUPLICATE_HEADER = 'x-simulated-duplicate';

const FAILURE_MESSAGES = {
  PAYMENT_FAILURE: 'Simulated payment gateway failure',
  INVENTORY_FAILURE: 'Simulated inventory service failure',
  EMAIL_FAILURE: 'Simulated e-mail (SMTP) service unavailable',
  PERSISTENT_FAILURE: 'Simulated persistent failure',
};

function appliesTo(fault, event) {
  const isTest = Boolean(event.metadata?.isTestEvent);
  if (fault.applyTo === APPLY_TO.TEST_EVENTS) return isTest;
  if (fault.applyTo === APPLY_TO.REAL_EVENTS) return !isTest;
  return true;
}

/** setTimeout that rejects as soon as `signal` aborts (no orphaned work after a timeout). */
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function beforeHandle({ consumerName, event, attempt, signal }) {
  let faults;
  try {
    faults = await getEnabledFaultsForConsumer(consumerName);
  } catch (err) {
    logger.warn(`[fault] could not read fault configuration (${err.message}); no fault injected`);
    return;
  }
  const relevant = faults.filter((f) => appliesTo(f, event));

  const delay = relevant.find((f) => f.faultType === 'ARTIFICIAL_DELAY');
  if (delay && (await tryTrigger(delay))) {
    logger.info(`[fault] ARTIFICIAL_DELAY ${delay.delayMs} ms -> ${consumerName} ${event.eventType} ${event.eventId} (attempt ${attempt})`);
    await abortableDelay(delay.delayMs, signal);
  }

  for (const fault of relevant.filter((f) => FAULT_TYPES[f.faultType].kind === 'FAILURE')) {
    if (await tryTrigger(fault)) {
      logger.info(`[fault] ${fault.faultType} -> ${consumerName} ${event.eventType} ${event.eventId} (attempt ${attempt})`);
      throw new TransientError(`[FAULT INJECTION] ${FAILURE_MESSAGES[fault.faultType]} (${fault.faultType}, attempt ${attempt})`);
    }
  }
}

async function afterSuccess({ consumerName, event, msg }) {
  if (msg.properties?.headers?.[SIMULATED_DUPLICATE_HEADER]) return; // never duplicate a duplicate
  const faults = await getEnabledFaultsForConsumer(consumerName);
  const fault = faults.find((f) => f.faultType === 'DUPLICATE_DELIVERY' && appliesTo(f, event));
  if (!fault || !(await tryTrigger(fault))) return;

  for (let i = 1; i <= fault.copies; i += 1) {
    await publishConfirmed('', mainQueueName(consumerName), msg.content, {
      persistent: true,
      contentType: 'application/json',
      messageId: msg.properties?.messageId ?? event.eventId,
      correlationId: msg.properties?.correlationId,
      type: msg.properties?.type,
      headers: { ...(msg.properties?.headers ?? {}), [SIMULATED_DUPLICATE_HEADER]: i },
    });
  }
  logger.info(`[fault] DUPLICATE_DELIVERY: ${fault.copies} extra copy(ies) of ${event.eventId} sent to ${consumerName}`);
}

/** Installs the hooks (no-op when fault injection is disabled, e.g. in production). */
export function installFaultInjection() {
  if (!config.faultInjection.enabled) {
    logger.info('Fault injection disabled (production or FAULT_INJECTION_ENABLED=false)');
    return false;
  }
  setBeforeHandleHook(beforeHandle);
  setAfterSuccessHook(afterSuccess);
  logger.info('Fault injection hooks installed (all faults are off until an admin enables one)');
  return true;
}
