/**
 * INVENTORY CONSUMER — ORDER_CREATED -> reserve stock -> INVENTORY_RESERVED | INVENTORY_FAILED.
 * The reservation (unique per order), the stock updates and the result event commit together
 * with the event's COMPLETED record.
 */
import { EVENT_TYPES } from '../events/eventTypes.js';
import { createChildEvent } from '../events/eventFactory.js';
import { addToOutbox } from '../outbox/outboxService.js';
import { CONSUMER_NAMES } from '../messaging/topology.js';
import { reserveForOrder } from '../services/inventory.service.js';

async function onOrderCreated(event, { session }) {
  const { orderId, orderNumber, items } = event.payload;
  const result = await reserveForOrder(orderId, items, event.eventId, session);
  if (result.outcome === 'ALREADY_PROCESSED') return; // never deduct twice

  const reserved = result.outcome === 'RESERVED';
  await addToOutbox(
    createChildEvent(event, {
      eventType: reserved ? EVENT_TYPES.INVENTORY_RESERVED : EVENT_TYPES.INVENTORY_FAILED,
      payload: reserved
        ? { orderId, orderNumber, items }
        : {
            orderId,
            orderNumber,
            reason: `Insufficient stock for ${result.shortages.map((s) => s.name || s.productId).join(', ')}`,
            shortages: result.shortages,
          },
    }),
    session
  );
}

export const inventoryConsumer = {
  name: CONSUMER_NAMES.INVENTORY,
  handlers: { [EVENT_TYPES.ORDER_CREATED]: onOrderCreated },
};
