import bcrypt from 'bcryptjs';
import { User, USER_ROLES } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { signToken } from './token.service.js';

const BCRYPT_ROUNDS = 12;

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

/** Public registration always creates CUSTOMER accounts; admins are created by the seed script. */
export async function registerUser({ name, email, password }) {
  const existing = await User.exists({ email });
  if (existing) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists');

  let user;
  try {
    user = await User.create({ name, email, passwordHash: await hashPassword(password), role: USER_ROLES.CUSTOMER });
  } catch (err) {
    // Race: two registrations with the same email at the same time -> unique index wins.
    if (err.code === 11000) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
    throw err;
  }
  return { user: user.toJSON(), token: signToken(user) };
}

export async function loginUser({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  // Same message for unknown email and wrong password (no account enumeration).
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  return { user: user.toJSON(), token: signToken(user) };
}

export async function getUserProfile(userId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  return user.toJSON();
}
