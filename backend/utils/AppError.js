/**
 * Operational error with an HTTP status code and a stable machine-readable code.
 * Anything that is not an AppError is treated as an unexpected 500 by the error handler.
 */
export class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status code
   * @param {string} code       Stable error code, e.g. "INSUFFICIENT_STOCK"
   * @param {string} message    Human-readable message (safe to show to the client)
   * @param {object} [options]
   * @param {unknown} [options.details]  Extra structured information (e.g. validation issues)
   * @param {Record<string,string>} [options.headers] Response headers to set (e.g. Retry-After)
   */
  constructor(statusCode, code, message, { details, headers } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.headers = headers;
    this.isOperational = true;
  }
}

/** Consistent JSON error body used by the error handler and by idempotent replays. */
export function toErrorBody(error) {
  const body = { success: false, error: { code: error.code, message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;
  return body;
}
