import { apiClient, unwrap } from './apiClient.js';

/** Fault injection + synthetic event generation (ADMIN, development/testing only). */
export const testingService = {
  faults: () => apiClient.get('/admin/faults').then(unwrap),
  enableFault: (config) => apiClient.post('/admin/faults/enable', config).then((r) => r.data),
  disableFault: (faultType, targetConsumer) => apiClient.post('/admin/faults/disable', { faultType, targetConsumer }).then((r) => r.data),
  disableAll: () => apiClient.post('/admin/faults/disable', { all: true }).then((r) => r.data),
  generateEvents: (count, eventType) =>
    apiClient.post('/admin/testing/generate-events', { count, eventType }, { timeout: 120000 }).then((r) => r.data.data),
  resetTestData: () => apiClient.post('/admin/testing/reset-test-data').then((r) => r.data),
  duplicateDelivery: (eventId, copies, consumer) =>
    apiClient.post('/admin/testing/duplicate-delivery', { eventId, copies, ...(consumer && { consumer }) }).then((r) => r.data),
};
