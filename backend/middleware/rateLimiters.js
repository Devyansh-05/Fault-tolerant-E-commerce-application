import { rateLimit } from 'express-rate-limit';
import { config } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/** Slows down credential-stuffing / brute-force attempts on login and registration. */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.isTest,
  handler: (req, res, next) =>
    next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Please wait a few minutes and try again.')),
});
