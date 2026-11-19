import { Router } from 'express';
import { health } from '../controllers/health.controller.js';
import authRoutes from './auth.routes.js';
import productRoutes from './product.routes.js';
import cartRoutes from './cart.routes.js';
import orderRoutes from './order.routes.js';
import adminRoutes from './admin.routes.js';
import eventRoutes from './event.routes.js';

const router = Router();

router.get('/health', health);
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/cart', cartRoutes);
router.use('/orders', orderRoutes);
router.use('/admin', adminRoutes);
router.use('/events', eventRoutes);

export default router;
