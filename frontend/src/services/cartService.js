import { apiClient, unwrap } from './apiClient.js';

const cartOf = (data) => data.cart;

export const cartService = {
  get: () => apiClient.get('/cart').then(unwrap).then(cartOf),
  add: (productId, quantity = 1) => apiClient.post('/cart/add', { productId, quantity }).then(unwrap).then(cartOf),
  update: (productId, quantity) => apiClient.put('/cart/update', { productId, quantity }).then(unwrap).then(cartOf),
  remove: (productId) => apiClient.delete(`/cart/remove/${productId}`).then(unwrap).then(cartOf),
  clear: () => apiClient.delete('/cart/clear').then(unwrap).then(cartOf),
};
