import { Router } from 'express';
import * as controller from '../controllers/order.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireIdempotencyKey } from '../middleware/idempotencyKey.js';
import { idParams } from '../validators/common.js';
import { createOrderSchema, listOrdersQuery } from '../validators/order.validators.js';

const router = Router();
router.use(authenticate);

// Order of middleware matters: auth -> Idempotency-Key header -> payload validation -> idempotent execution.
router.post('/', requireIdempotencyKey, validate({ body: createOrderSchema }), controller.createOrder);
router.get('/', validate({ query: listOrdersQuery }), controller.listOrders);
router.get('/:id', validate({ params: idParams }), controller.getOrder);

export default router;
