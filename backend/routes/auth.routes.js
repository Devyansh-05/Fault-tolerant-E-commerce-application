import { Router } from 'express';
import * as controller from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { authRateLimiter } from '../middleware/rateLimiters.js';
import { loginSchema, registerSchema } from '../validators/auth.validators.js';

const router = Router();

router.post('/register', authRateLimiter, validate({ body: registerSchema }), controller.register);
router.post('/login', authRateLimiter, validate({ body: loginSchema }), controller.login);
router.get('/me', authenticate, controller.me);

export default router;
