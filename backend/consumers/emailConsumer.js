/**
 * EMAIL CONSUMER — sends (simulated) customer e-mails.
 * It only reacts to FINAL order outcomes, so a confirmation e-mail is never sent before
 * payment AND stock reservation have both succeeded.
 */
import { EVENT_TYPES } from '../events/eventTypes.js';
import { CONSUMER_NAMES } from '../messaging/topology.js';
import { sendSimulatedEmail } from '../services/notification.service.js';
import { formatInr } from '../utils/money.js';

async function onOrderConfirmed(event, { session }) {
  const { orderId, orderNumber, totalAmount, customer } = event.payload;
  await sendSimulatedEmail(
    {
      eventId: event.eventId,
      orderId,
      template: 'ORDER_CONFIRMED',
      to: customer.email,
      subject: `Your ShopSphere order ${orderNumber ?? ''} is confirmed`.trim(),
      body: `Hi ${customer.name}, your order ${orderNumber ?? orderId} (${formatInr(totalAmount)}) is confirmed and will be shipped soon.`,
    },
    session
  );
}

async function onOrderFailed(event, { session }) {
  const { orderId, orderNumber, reason, customer, compensation } = event.payload;
  const refund = compensation.paymentRefunded ? ' Your payment has been refunded.' : '';
  await sendSimulatedEmail(
    {
      eventId: event.eventId,
      orderId,
      template: 'ORDER_FAILED',
      to: customer.email,
      subject: `We could not complete your ShopSphere order ${orderNumber ?? ''}`.trim(),
      body: `Hi ${customer.name}, unfortunately your order ${orderNumber ?? orderId} could not be completed (${reason}).${refund}`,
    },
    session
  );
}

async function onNotificationRequested(event, { session }) {
  const { to, subject, body, orderId, template } = event.payload;
  await sendSimulatedEmail({ eventId: event.eventId, orderId: orderId ?? null, template: template ?? 'CUSTOM', to, subject, body }, session);
}

export const emailConsumer = {
  name: CONSUMER_NAMES.EMAIL,
  handlers: {
    [EVENT_TYPES.ORDER_CONFIRMED]: onOrderConfirmed,
    [EVENT_TYPES.ORDER_FAILED]: onOrderFailed,
    [EVENT_TYPES.EMAIL_NOTIFICATION_REQUESTED]: onNotificationRequested,
  },
};
