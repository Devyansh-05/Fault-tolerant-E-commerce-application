/**
 * Client-side Idempotency-Key management for checkout.
 *
 * Rules:
 *  - A new UUID is generated for a genuinely new order operation.
 *  - The SAME key is reused when the same logical submission is retried
 *    (e.g. after a timeout or network error, or a page refresh mid-request),
 *    because the first request may already have created the order on the server.
 *  - If the payload changes (different cart/address), it is a new operation -> new key.
 *  - The key is discarded once the server gives a definitive answer.
 *
 * The pending key is kept in sessionStorage so it survives a page refresh in the same tab.
 */
const STORAGE_KEY = 'shopsphere.pendingCheckout';

export function generateIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback for very old browsers (RFC 4122 v4 using getRandomValues).
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable string for a checkout payload (items sorted, keys sorted). */
function payloadSignature(payload) {
  const sortKeys = (v) =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
        : v;
  const items = [...payload.items].sort((a, b) => a.productId.localeCompare(b.productId));
  return JSON.stringify(sortKeys({ ...payload, items }));
}

function read() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

/** Returns the key for this submission: reuses the pending key if the payload is unchanged. */
export function getCheckoutKey(payload) {
  const signature = payloadSignature(payload);
  const pending = read();
  if (pending?.signature === signature && pending.key) return pending.key;

  const key = generateIdempotencyKey();
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ key, signature, createdAt: Date.now() }));
  } catch {
    /* storage unavailable — the key still works for in-page retries */
  }
  return key;
}

/** Call when the server has given a definitive result (success or business failure). */
export function clearCheckoutKey() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
