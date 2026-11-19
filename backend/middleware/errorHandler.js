import mongoose from 'mongoose';
import { AppError, toErrorBody } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

export function notFound(req, res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

/** Converts known library errors into AppErrors; everything else becomes a generic 500. */
export function normalizeError(err) {
  if (err instanceof AppError) return err;

  if (err?.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (err?.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');

  if (err instanceof mongoose.Error.CastError) {
    return new AppError(400, 'INVALID_ID', `Invalid value for ${err.path}`);
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return new AppError(400, 'VALIDATION_ERROR', 'Validation failed', { details });
  }
  if (err?.code === 11000) {
    return new AppError(409, 'DUPLICATE_RESOURCE', 'A resource with the same unique value already exists', {
      details: { fields: Object.keys(err.keyPattern || {}) },
    });
  }

  const wrapped = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  wrapped.cause = err;
  return wrapped;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const appError = normalizeError(err);

  if (appError.statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${appError.statusCode} ${appError.code}`, err?.stack || err);
  }
  if (appError.headers) res.set(appError.headers);
  res.status(appError.statusCode).json(toErrorBody(appError));
}
