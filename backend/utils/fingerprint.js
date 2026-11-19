import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so that
 * {a:1,b:2} and {b:2,a:1} produce the same string. Array order is preserved
 * (callers normalise array order where it is not semantically meaningful).
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * SHA-256 request fingerprint. Used to detect an Idempotency-Key being reused
 * with a different request payload.
 */
export function computeFingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
