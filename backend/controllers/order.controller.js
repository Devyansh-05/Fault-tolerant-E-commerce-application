import * as orderService from '../services/order.service.js';
import { executeIdempotent } from '../services/idempotency.service.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { AppError } from '../utils/AppError.js';

export const ORDER_CREATE_SCOPE = 'orders.create';

const orderCreatedResponse = (order) => ({
  statusCode: 201,
  body: { success: true, message: 'Order placed successfully', data: { order } },
});

/**
 * POST /api/orders — idempotent order creation.
 * Requires the Idempotency-Key header (validated by middleware).
 */
export async function createOrder(req, res) {
  const userId = req.user.id;
  const key = req.idempotencyKey;
  // Fingerprint of the normalised payload (validated, unknown fields stripped, items sorted).
  const fingerprint = computeFingerprint({ scope: ORDER_CREATE_SCOPE, payload: req.body });

  const result = await executeIdempotent({
    scope: ORDER_CREATE_SCOPE,
    userId,
    key,
    fingerprint,

    // Durable check: has an order with this key already been committed to MongoDB?
    recover: async () => {
      const found = await orderService.findOrderByIdempotencyKey(userId, key);
      return found ? { fingerprint: found.requestFingerprint, response: orderCreatedResponse(found.order) } : null;
    },

    handler: async () => {
      const { order, alreadyExisted, requestFingerprint } = await orderService.createOrder({
        userId,
        ...req.body,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
      });
      if (alreadyExisted && requestFingerprint !== fingerprint) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used with a different request payload. Use a new key for a new request.'
        );
      }
      return { ...orderCreatedResponse(order), replayed: alreadyExisted };
    },
  });

  if (result.replayed) {
    // Same status and body as the original response, plus explicit replay markers.
    res.set('Idempotent-Replayed', 'true');
    return res.status(result.statusCode).json({ ...result.body, idempotentReplay: true });
  }
  return res.status(result.statusCode).json(result.body);
}

export async function listOrders(req, res) {
  res.json({ success: true, data: await orderService.listUserOrders(req.user.id, req.validated.query) });
}

export async function getOrder(req, res) {
  res.json({ success: true, data: { order: await orderService.getOrderForUser(req.validated.params.id, req.user) } });
}
