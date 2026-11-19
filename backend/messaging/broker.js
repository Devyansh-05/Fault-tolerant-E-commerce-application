import { connectRabbitMQ, setTopology } from '../config/rabbitmq.js';
import { assertTopology } from './topology.js';

/** Connects to RabbitMQ and (re)declares the topology on every (re)connect. Never throws. */
export async function initBroker(options) {
  setTopology(assertTopology);
  await connectRabbitMQ(options);
}
