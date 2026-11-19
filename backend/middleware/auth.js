import { User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { verifyToken } from '../services/token.service.js';

/**
 * Requires a valid "Authorization: Bearer <JWT>" header.
 * The user is re-loaded from the database so deleted users or changed roles take effect immediately.
 */
export async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Your session is invalid or has expired. Please log in again.');
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new AppError(401, 'INVALID_TOKEN', 'Your session is invalid. Please log in again.');

  req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  next();
}

/** Role-based authorisation; use after `authenticate`. */
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }
    next();
  };
