import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

export function signToken(user) {
  return jwt.sign({ sub: String(user.id ?? user._id), role: user.role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    algorithm: 'HS256',
  });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
}
