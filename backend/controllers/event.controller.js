import * as monitoring from '../services/eventMonitoring.service.js';
import { replayDeadLetter } from '../services/eventOperations.service.js';

export const list = async (req, res) => res.json({ success: true, data: await monitoring.listEventRecords(req.validated.query) });
export const stats = async (req, res) => res.json({ success: true, data: await monitoring.getEventStats(req.validated.query) });
export const consumerStats = async (req, res) =>
  res.json({ success: true, data: await monitoring.getConsumerStats(req.validated.query) });
export const dlq = async (req, res) => res.json({ success: true, data: await monitoring.listDeadLetters(req.validated.query) });
export const outbox = async (req, res) => res.json({ success: true, data: await monitoring.listOutbox(req.validated.query) });
export const processingConfig = async (req, res) => res.json({ success: true, data: monitoring.getProcessingConfig() });
export const details = async (req, res) =>
  res.json({ success: true, data: await monitoring.getEventDetails(req.validated.params.eventId) });

export async function replay(req, res) {
  const result = await replayDeadLetter(req.validated.params.eventId, req.body.consumer, req.user);
  res.status(202).json({ success: true, message: result.message, data: result });
}
