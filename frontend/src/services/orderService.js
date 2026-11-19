import { apiClient, unwrap } from './apiClient.js';

export const orderService = {
  /**
   * Creates an order. `idempotencyKey` identifies the logical checkout submission;
   * retries of the same submission MUST reuse the same key.
   * Resolves to { order, replayed } where replayed=true means the server returned
   * the result of an earlier request with this key instead of creating a new order.
   */
  create: async (payload, idempotencyKey) => {
    const response = await apiClient.post('/orders', payload, { headers: { 'Idempotency-Key': idempotencyKey } });
    return {
      order: response.data.data.order,
      replayed: response.data.idempotentReplay === true || response.headers['idempotent-replayed'] === 'true',
    };
  },
  list: (params = {}) => apiClient.get('/orders', { params }).then(unwrap),
  get: (id) => apiClient.get(`/orders/${id}`).then(unwrap).then((d) => d.order),
};
