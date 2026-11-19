import { AppError } from '../utils/AppError.js';

// UUIDs (recommended) and other opaque tokens of reasonable length are accepted.
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Requires a well-formed `Idempotency-Key` header and exposes it as `req.idempotencyKey`. */
export function requireIdempotencyKey(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (!key) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required for this request');
  }
  if (!KEY_PATTERN.test(key)) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_INVALID',
      'Idempotency-Key must be 8-128 characters of letters, digits, "-" or "_" (a UUID is recommended)'
    );
  }
  req.idempotencyKey = key;
  next();
}
