/**
 * Failure classification for the Reliable Event Processor.
 *
 * TRANSIENT  — may succeed if retried (timeouts, broker/database hiccups, simulated outages).
 * PERMANENT  — retrying cannot help (invalid schema, invalid business data). Goes straight to DLQ.
 *
 * Unknown errors are treated as TRANSIENT: they are retried with back-off and end in the DLQ
 * if they keep failing, so nothing is silently dropped.
 */
export class TransientError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'TransientError';
    this.retryable = true;
    if (cause) this.cause = cause;
  }
}

export class PermanentError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'PermanentError';
    this.retryable = false;
    if (cause) this.cause = cause;
  }
}

export class ProcessingTimeoutError extends TransientError {
  constructor(ms) {
    super(`Event processing timed out after ${ms} ms`);
    this.name = 'ProcessingTimeoutError';
  }
}

/** Thrown inside the processing transaction when another delivery already completed the event. */
export class AlreadyCompletedError extends Error {
  constructor() {
    super('Event was already completed by another delivery');
    this.name = 'AlreadyCompletedError';
  }
}

export function isRetryable(error) {
  if (error?.retryable === false) return false;
  if (error?.retryable === true) return true;
  if (error?.name === 'ZodError') return false;
  if (error?.name === 'ValidationError' || error?.name === 'CastError') return false; // Mongoose data errors
  return true;
}

export const errorMessage = (error) => (error?.message ? String(error.message).slice(0, 1000) : String(error));
