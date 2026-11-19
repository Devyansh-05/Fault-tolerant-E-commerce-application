/**
 * Event catalogue. Every event type has exactly one routing key on the topic exchange.
 *
 * Saga (parallel choreography):
 *   ORDER_CREATED ──► payment consumer   ──► PAYMENT_COMPLETED | PAYMENT_FAILED ─┐
 *                └─► inventory consumer ──► INVENTORY_RESERVED | INVENTORY_FAILED ┤
 *                                                                                 ▼
 *                                  order consumer (Order Service saga coordinator)
 *                                  waits for BOTH results, then (atomically):
 *                                    both ok  -> ORDER_CONFIRMED
 *                                    any fail -> compensate (refund / release stock) + ORDER_FAILED
 *   ORDER_CONFIRMED | ORDER_FAILED | EMAIL_NOTIFICATION_REQUESTED ──► email consumer
 */
export const EVENT_TYPES = Object.freeze({
  ORDER_CREATED: 'ORDER_CREATED',
  PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INVENTORY_RESERVED: 'INVENTORY_RESERVED',
  INVENTORY_FAILED: 'INVENTORY_FAILED',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_FAILED: 'ORDER_FAILED',
  EMAIL_NOTIFICATION_REQUESTED: 'EMAIL_NOTIFICATION_REQUESTED',
});

export const ROUTING_KEYS = Object.freeze({
  ORDER_CREATED: 'order.created',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_FAILED: 'inventory.failed',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_FAILED: 'order.failed',
  EMAIL_NOTIFICATION_REQUESTED: 'email.notification.requested',
});

export const CURRENT_EVENT_VERSION = 1;

export const routingKeyFor = (eventType) => {
  const key = ROUTING_KEYS[eventType];
  if (!key) throw new Error(`Unknown event type: ${eventType}`);
  return key;
};
