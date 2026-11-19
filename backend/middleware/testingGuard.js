import { config } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/**
 * Fault injection and synthetic event generation exist only in development/testing.
 * In production (NODE_ENV=production) or with FAULT_INJECTION_ENABLED=false every request is
 * rejected — this check runs on the backend, independently of any frontend route guard.
 */
export function requireTestingTools(req, res, next) {
  if (!config.faultInjection.enabled) {
    throw new AppError(403, 'TESTING_TOOLS_DISABLED', 'Fault injection and test-event generation are disabled in this environment');
  }
  next();
}
