import { Router } from 'express';
import * as controller from '../controllers/admin.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { USER_ROLES } from '../models/index.js';
import { faultRoutes, testingRoutes } from './testing.routes.js';

/**
 * Admin-only API. Every route mounted here requires an ADMIN JWT (checked on the backend).
 * Fault injection and the test-event generator are additionally disabled in production.
 */
const router = Router();
router.use(authenticate, requireRole(USER_ROLES.ADMIN));

router.get('/overview', controller.overview);
router.use('/faults', faultRoutes);
router.use('/testing', testingRoutes);

export default router;
