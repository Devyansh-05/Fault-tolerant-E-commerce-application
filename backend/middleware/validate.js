import { AppError } from '../utils/AppError.js';

/**
 * Validates req.params / req.query / req.body with Zod schemas.
 * Parsed (trimmed, coerced, unknown-keys-stripped) values are placed on `req.validated`;
 * the parsed body also replaces `req.body`.
 */
export const validate = (schemas) => (req, res, next) => {
  const validated = {};
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || part,
        message: issue.message,
      }));
      return next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', { details }));
    }
    validated[part] = result.data;
  }
  req.validated = validated;
  if (validated.body) req.body = validated.body;
  return next();
};
