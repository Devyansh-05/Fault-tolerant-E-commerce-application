import { Router } from 'express';
import * as controller from '../controllers/event.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { USER_ROLES } from '../models/index.js';
import { dlqQuery, eventIdParams, listEventsQuery, outboxQuery, statsQuery } from '../validators/event.validators.js';
import { replaySchema } from '../validators/testing.validators.js';

/** Event monitoring API (ADMIN only) — data source for the Stage 3 Reliability Dashboard. */
const router = Router();
router.use(authenticate, requireRole(USER_ROLES.ADMIN));

router.get('/', validate({ query: listEventsQuery }), controller.list);
router.get('/stats', validate({ query: statsQuery }), controller.stats);
router.get('/consumer-stats', validate({ query: statsQuery }), controller.consumerStats);
router.get('/dlq', validate({ query: dlqQuery }), controller.dlq);
router.get('/outbox', validate({ query: outboxQuery }), controller.outbox);
router.get('/config', controller.processingConfig);
router.post('/dlq/:eventId/replay', validate({ params: eventIdParams, body: replaySchema }), controller.replay);
router.get('/:eventId', validate({ params: eventIdParams }), controller.details);

export default router;
