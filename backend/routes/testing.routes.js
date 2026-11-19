import { Router } from 'express';
import * as controller from '../controllers/testing.controller.js';
import { validate } from '../middleware/validate.js';
import { requireTestingTools } from '../middleware/testingGuard.js';
import { disableFaultSchema, duplicateDeliverySchema, enableFaultSchema, generateEventsSchema } from '../validators/testing.validators.js';

/**
 * Mounted inside the ADMIN router (/api/admin), so authenticate + requireRole('ADMIN') already
 * apply. Additionally blocked outside development/testing.
 *
 *   GET  /api/admin/faults
 *   POST /api/admin/faults/enable
 *   POST /api/admin/faults/disable
 *   POST /api/admin/testing/generate-events
 *   POST /api/admin/testing/duplicate-delivery
 *   POST /api/admin/testing/reset-test-data   (deletes synthetic test data only)
 */
export const faultRoutes = Router();
faultRoutes.use(requireTestingTools);
faultRoutes.get('/', controller.getFaults);
faultRoutes.post('/enable', validate({ body: enableFaultSchema }), controller.enableFault);
faultRoutes.post('/disable', validate({ body: disableFaultSchema }), controller.disableFault);

export const testingRoutes = Router();
testingRoutes.use(requireTestingTools);
testingRoutes.post('/generate-events', validate({ body: generateEventsSchema }), controller.generateEvents);
testingRoutes.post('/duplicate-delivery', validate({ body: duplicateDeliverySchema }), controller.duplicateDelivery);
testingRoutes.post('/reset-test-data', controller.resetData);
