/**
 * Simulated e-mail service. No external provider is contacted; the "sent" e-mail is stored
 * in the notifications collection (and logged). The unique eventId makes it idempotent.
 *
 * Limitation (documented): with a REAL e-mail provider the send would be an external side
 * effect outside the MongoDB transaction, so delivery would be at-least-once; providers that
 * accept an idempotency key (we pass eventId) reduce that to effectively-once.
 */
import { createHash } from 'node:crypto';
import { Notification } from '../models/index.js';
import { logger } from '../utils/logger.js';

const providerMessageId = (eventId) => `SIMMAIL-${createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`;

/** @returns {{ sent: boolean, notification }} sent=false if this event already produced a notification */
export async function sendSimulatedEmail({ eventId, orderId = null, template, to, subject, body }, session) {
  const existing = await Notification.findOne({ eventId }).session(session);
  if (existing) return { sent: false, notification: existing };

  const [notification] = await Notification.create(
    [{ eventId, orderId, template, to, subject, body, status: 'SENT', providerMessageId: providerMessageId(eventId), sentAt: new Date() }],
    { session }
  );
  logger.info(`[email] (simulated) "${subject}" -> ${to}`);
  return { sent: true, notification };
}
