import { Router } from 'express';
import * as controller from '../controllers/product.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validators/common.js';
import { createProductSchema, listProductsQuery, updateProductSchema } from '../validators/product.validators.js';
import { USER_ROLES } from '../models/index.js';

const router = Router();
const adminOnly = [authenticate, requireRole(USER_ROLES.ADMIN)];

// Public catalogue
router.get('/', validate({ query: listProductsQuery }), controller.list);
router.get('/categories', controller.categories);
router.get('/:id', validate({ params: idParams }), controller.getById);

// Admin product management
router.post('/', ...adminOnly, validate({ body: createProductSchema }), controller.create);
router.put('/:id', ...adminOnly, validate({ params: idParams, body: updateProductSchema }), controller.update);
router.delete('/:id', ...adminOnly, validate({ params: idParams }), controller.remove);

export default router;
