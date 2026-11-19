import { apiClient, unwrap } from './apiClient.js';

const clean = (params) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));

/** Event-monitoring API (ADMIN). All numbers are computed by the backend from real records. */
export const monitoringService = {
  stats: (params = {}) => apiClient.get('/events/stats', { params: clean(params) }).then(unwrap),
  consumerStats: (params = {}) => apiClient.get('/events/consumer-stats', { params: clean(params) }).then(unwrap),
  events: (params = {}) => apiClient.get('/events', { params: clean(params) }).then(unwrap),
  event: (eventId) => apiClient.get(`/events/${encodeURIComponent(eventId)}`).then(unwrap),
  dlq: (params = {}) => apiClient.get('/events/dlq', { params: clean(params) }).then(unwrap),
  outbox: (params = {}) => apiClient.get('/events/outbox', { params: clean(params) }).then(unwrap),
  config: () => apiClient.get('/events/config').then(unwrap),
  replay: (eventId, consumer) => apiClient.post(`/events/dlq/${encodeURIComponent(eventId)}/replay`, { consumer }).then((r) => r.data),
};
