import { paymentConsumer } from './paymentConsumer.js';
import { inventoryConsumer } from './inventoryConsumer.js';
import { orderConsumer } from './orderConsumer.js';
import { emailConsumer } from './emailConsumer.js';

/** All consumer definitions, keyed by name (payment | inventory | order | email). */
export const CONSUMERS = Object.freeze({
  [paymentConsumer.name]: paymentConsumer,
  [inventoryConsumer.name]: inventoryConsumer,
  [orderConsumer.name]: orderConsumer,
  [emailConsumer.name]: emailConsumer,
});
