import * as faults from '../services/faultInjection.service.js';
import { generateTestEvents, resetTestData } from '../services/eventGenerator.service.js';
import { redeliverEvent } from '../services/eventOperations.service.js';

export const getFaults = async (req, res) => res.json({ success: true, data: await faults.getFaultOverview() });

export async function enableFault(req, res) {
  const fault = await faults.enableFault(req.body, req.user);
  res.json({ success: true, message: `${fault.label} enabled on the ${fault.targetConsumer} consumer`, data: { fault } });
}

export async function disableFault(req, res) {
  const result = await faults.disableFault(req.body, req.user);
  res.json({ success: true, message: req.body.all ? `All faults disabled (${result.disabled})` : 'Fault disabled', data: result });
}

export async function generateEvents(req, res) {
  const result = await generateTestEvents(req.body, req.user.email);
  // 201 when everything was accepted, 207-like partial result is still reported truthfully.
  res.status(result.failed === 0 ? 201 : result.accepted > 0 ? 200 : 500).json({ success: result.failed === 0, data: result });
}

export async function resetData(req, res) {
  const result = await resetTestData(req.user.email);
  res.json({ success: true, message: 'Synthetic test data deleted', data: result });
}

export async function duplicateDelivery(req, res) {
  const result = await redeliverEvent(req.body, req.user);
  res.json({ success: true, message: `Event delivered again ${result.copies} time(s)`, data: result });
}
