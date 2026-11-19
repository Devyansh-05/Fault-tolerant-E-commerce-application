/**
 * ORDER CONSUMER (Order Service saga coordinator) — combines payment and inventory results
 * into the final order status, runs compensations, and emits ORDER_CONFIRMED / ORDER_FAILED.
 */
import { EVENT_TYPES } from '../events/eventTypes.js';
import { CONSUMER_NAMES } from '../messaging/topology.js';
import { applyStepResult } from '../services/orderSaga.service.js';

const onStepResult = async (event, { session }) => {
  await applyStepResult(event, session);
};

export const orderConsumer = {
  name: CONSUMER_NAMES.ORDER,
  handlers: {
    [EVENT_TYPES.PAYMENT_COMPLETED]: onStepResult,
    [EVENT_TYPES.PAYMENT_FAILED]: onStepResult,
    [EVENT_TYPES.INVENTORY_RESERVED]: onStepResult,
    [EVENT_TYPES.INVENTORY_FAILED]: onStepResult,
  },
};
