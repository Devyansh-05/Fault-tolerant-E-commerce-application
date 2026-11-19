// Importing this module registers every Mongoose model.
export { User, USER_ROLES } from './User.js';
export { Product } from './Product.js';
export { Inventory } from './Inventory.js';
export { Cart, MAX_QUANTITY_PER_ITEM } from './Cart.js';
export { Order, ORDER_STATUS, PAYMENT_STATUS, STEP_STATUS, TERMINAL_ORDER_STATUSES } from './Order.js';
export { Payment, PAYMENT_RECORD_STATUS } from './Payment.js';
// Stage 2 — event-driven processing
export { OutboxEvent, OUTBOX_STATUS } from './OutboxEvent.js';
export { EventProcessing, EVENT_STATUS, FAILURE_TYPE } from './EventProcessing.js';
export { Notification } from './Notification.js';
export { InventoryReservation, RESERVATION_STATUS } from './InventoryReservation.js';
