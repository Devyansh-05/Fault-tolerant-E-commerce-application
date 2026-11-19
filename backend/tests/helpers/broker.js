import { getConnection, publishConfirmed } from '../../config/rabbitmq.js';
import { describeTopology, dlqName, exchangeName } from '../../messaging/topology.js';
import { sleep } from '../../utils/helpers.js';

/** Empties every TEST queue (main, retry, DLQ). */
export async function purgeTestQueues() {
  const channel = await getConnection().createChannel();
  try {
    for (const t of describeTopology()) {
      for (const queue of [t.queue, t.dlq, ...t.retryQueues]) await channel.purgeQueue(queue);
    }
  } finally {
    await channel.close();
  }
}

/** Publishes a raw envelope (or arbitrary body) straight to the events exchange. */
export async function publishRaw(routingKey, body, properties = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  await publishConfirmed(exchangeName(), routingKey, content, { contentType: 'application/json', ...properties });
}

/** Reads (and removes) messages from a consumer's DLQ until `predicate` matches. */
export async function takeFromDlq(consumer, predicate, timeoutMs = 10000) {
  const channel = await getConnection().createChannel();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const msg = await channel.get(dlqName(consumer), { noAck: false });
      if (!msg) {
        await sleep(200);
        continue;
      }
      channel.ack(msg);
      if (predicate(msg)) return msg;
    }
    return null;
  } finally {
    await channel.close();
  }
}

export async function queueDepth(queue) {
  const channel = await getConnection().createChannel();
  try {
    return (await channel.checkQueue(queue)).messageCount;
  } finally {
    await channel.close();
  }
}

/** Polls `fn` until it returns a truthy value (returned) or the timeout elapses (throws). */
export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 250, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${message} (last value: ${JSON.stringify(last)})`);
}
