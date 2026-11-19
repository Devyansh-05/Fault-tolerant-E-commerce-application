import { apiClient, unwrap } from './apiClient.js';

const clean = (params) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));

export const productService = {
  list: (params = {}) => apiClient.get('/products', { params: clean(params) }).then(unwrap),
  categories: () => apiClient.get('/products/categories').then(unwrap).then((d) => d.categories),
  get: (id) => apiClient.get(`/products/${id}`).then(unwrap).then((d) => d.product),
  // Admin
  create: (payload) => apiClient.post('/products', payload).then(unwrap).then((d) => d.product),
  update: (id, payload) => apiClient.put(`/products/${id}`, payload).then(unwrap).then((d) => d.product),
  remove: (id) => apiClient.delete(`/products/${id}`),
};
