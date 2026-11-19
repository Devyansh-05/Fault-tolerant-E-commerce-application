import { apiClient, unwrap } from './apiClient.js';

export const authService = {
  register: (payload) => apiClient.post('/auth/register', payload).then(unwrap),
  login: (payload) => apiClient.post('/auth/login', payload).then(unwrap),
  me: () => apiClient.get('/auth/me').then(unwrap),
};
