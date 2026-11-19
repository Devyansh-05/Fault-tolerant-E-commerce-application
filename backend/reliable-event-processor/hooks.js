/**
 * Extension points of the Reliable Event Processor.
 *
 *  beforeHandle(ctx)  runs right before the business handler, inside the attempt's timeout.
 *                     It may throw (TransientError / PermanentError -> handled exactly like a
 *                     real failure) or await a delay (subject to the processing timeout; it
 *                     should honour ctx.signal so a timed-out attempt stops early).
 *  afterSuccess(ctx)  runs after an event was COMPLETED and acknowledged (errors are logged,
 *                     never affect the outcome). Used to simulate duplicate delivery.
 *
 * The Stage 3 Fault Injection Module (fault-injection/faultInjector.js) installs both hooks in
 * the worker process. Tests may install their own. Hooks never mark anything as successful —
 * outcomes are always decided by the real processing path.
 * Default: no hooks (no faults).
 */
let beforeHandleHook = null;
let afterSuccessHook = null;

export function setBeforeHandleHook(hook) {
  beforeHandleHook = typeof hook === 'function' ? hook : null;
}

export function setAfterSuccessHook(hook) {
  afterSuccessHook = typeof hook === 'function' ? hook : null;
}

export function clearHooks() {
  beforeHandleHook = null;
  afterSuccessHook = null;
}

export async function runBeforeHandle(context) {
  if (beforeHandleHook) await beforeHandleHook(context);
}

export async function runAfterSuccess(context) {
  if (afterSuccessHook) await afterSuccessHook(context);
}
