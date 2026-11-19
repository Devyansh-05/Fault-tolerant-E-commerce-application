import { apiClient, unwrap } from './apiClient.js';

// Stage 3 will add reliability statistics, fault injection and event generator calls here.
export const adminService = {
  overview: () => apiClient.get('/admin/overview').then(unwrap),
};
