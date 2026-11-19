// Fast timings for the event-processing tests (imported right after helpers/env.js, before
// config/env.js loads). dotenv never overrides variables that are already set.
Object.assign(process.env, {
  MAX_RETRIES: '3',
  INITIAL_RETRY_DELAY_MS: '300',
  MAX_RETRY_DELAY_MS: '2000',
  RETRY_BACKOFF_MULTIPLIER: '2',
  EVENT_PROCESSING_TIMEOUT_MS: '8000',
  EVENT_LEASE_MS: '9000',
  OUTBOX_POLL_INTERVAL_MS: '100',
  OUTBOX_CLAIM_TIMEOUT_MS: '1500',
  OUTBOX_MAX_BACKOFF_MS: '1000',
  SIMULATED_PAYMENT_DECLINE_ABOVE: '50000',
});
