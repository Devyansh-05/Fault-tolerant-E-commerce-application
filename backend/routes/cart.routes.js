import { Router } from 'express';
import * as controller from '../controllers/cart.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { productIdParams } from '../validators/common.js';
import { addToCartSchema, updateCartSchema } from '../validators/cart.validators.js';

const router = Router();
router.use(authenticate);

router.get('/', controller.getCart);
router.post('/add', validate({ body: addToCartSchema }), controller.addItem);
router.put('/update', validate({ body: updateCartSchema }), controller.updateItem);
router.delete('/remove/:productId', validate({ params: productIdParams }), controller.removeItem);
router.delete('/clear', controller.clearCart);

export default router;
