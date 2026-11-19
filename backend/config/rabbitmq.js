/**
 * Centralised RabbitMQ connection (amqplib).
 *
 * - ONE connection per process, plus ONE confirm channel for all publishing.
 *   Consumers create their own channels from the shared connection (per-consumer prefetch).
 * - Publisher confirms: `publishConfirmed()` resolves only after the broker has taken
 *   responsibility for the message (persisted for durable queues).
 * - Automatic reconnect with exponential back-off. After every (re)connect the topology is
 *   re-asserted and every registered "ready" listener runs again, so consumers resubscribe.
 * - If the broker is down, publishing fails fast with BrokerUnavailableError; callers
 *   (the Outbox Publisher) keep the event in MongoDB and retry later — nothing is lost.
 */
import os from 'node:os';
import amqp from 'amqplib';
import { config } from './env.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

export class BrokerUnavailableError extends Error {
  constructor(message = 'RabbitMQ is not connected') {
    super(message);
    this.name = 'BrokerUnavailableError';
    this.transient = true;
  }
}

const state = {
  connection: null,
  confirmChannel: null,
  status: 'disconnected', // disconnected | connecting | connected | closing
  started: false,
  closing: false,
  reconnectTimer: null,
  reconnectAttempt: 0,
  connectingPromise: null,
  topology: null, // async (channel) => void
  readyListeners: new Set(),
  lastError: null,
};

/** Registers the function that declares exchanges/queues. It runs after every (re)connect. */
export function setTopology(setupFn) {
  state.topology = setupFn;
}

/**
 * Registers a listener invoked with the live connection after every successful (re)connect.
 * If already connected, it is invoked immediately. Returns an unsubscribe function.
 */
export function onBrokerReady(listener) {
  state.readyListeners.add(listener);
  if (state.status === 'connected' && state.connection) {
    Promise.resolve(listener(state.connection)).catch((err) => logger.error(`Broker ready listener failed: ${err.message}`));
  }
  return () => state.readyListeners.delete(listener);
}

function scheduleReconnect() {
  if (state.closing || state.reconnectTimer) return;
  const delay = Math.min(500 * 2 ** Math.min(state.reconnectAttempt, 4), 5000);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    establish().catch(() => {});
  }, delay);
}

async function createConfirmChannel(connection) {
  const channel = await connection.createConfirmChannel();
  channel.on('error', (err) => logger.warn(`RabbitMQ publish channel error: ${err.message}`));
  channel.on('close', () => {
    if (state.confirmChannel === channel) state.confirmChannel = null;
    // Channel closed but connection still alive (e.g. a channel-level error): reopen it.
    if (!state.closing && state.connection === connection) {
      createConfirmChannel(connection)
        .then((ch) => (state.confirmChannel = ch))
        .catch((err) => logger.warn(`Could not reopen publish channel: ${err.message}`));
    }
  });
  return channel;
}

async function establish() {
  if (state.closing) return;
  if (state.connectingPromise) return state.connectingPromise;

  state.status = 'connecting';
  state.connectingPromise = (async () => {
    let connection;
    try {
      connection = await amqp.connect(config.rabbitmq.url, {
        clientProperties: { connection_name: `ecommerce-${os.hostname()}-${process.pid}` },
        timeout: 5000,
      });
    } catch (err) {
      state.status = 'disconnected';
      state.lastError = err.message;
      if (state.reconnectAttempt === 0 || state.reconnectAttempt % 10 === 0) {
        logger.warn(`RabbitMQ connection failed (${err.message}); retrying in the background`);
      }
      scheduleReconnect();
      throw err;
    }

    connection.on('error', (err) => logger.warn(`RabbitMQ connection error: ${err.message}`));
    connection.on('blocked', (reason) => logger.warn(`RabbitMQ connection blocked: ${reason}`));
    connection.on('close', () => {
      if (state.connection !== connection) return;
      state.connection = null;
      state.confirmChannel = null;
      state.status = state.closing ? 'disconnected' : 'disconnected';
      if (!state.closing) {
        logger.warn('RabbitMQ connection lost; reconnecting...');
        scheduleReconnect();
      }
    });

    try {
      const confirmChannel = await createConfirmChannel(connection);
      if (state.topology) await state.topology(confirmChannel);
      state.connection = connection;
      state.confirmChannel = confirmChannel;
      state.status = 'connected';
      state.reconnectAttempt = 0;
      state.lastError = null;
      logger.info('RabbitMQ connected and topology asserted');
    } catch (err) {
      state.lastError = err.message;
      logger.error(`RabbitMQ setup failed: ${err.message}`);
      state.status = 'disconnected';
      try {
        await connection.close();
      } catch {
        /* ignore */
      }
      scheduleReconnect();
      throw err;
    }

    for (const listener of state.readyListeners) {
      try {
        await listener(connection);
      } catch (err) {
        logger.error(`Broker ready listener failed: ${err.message}`);
      }
    }
  })().finally(() => {
    state.connectingPromise = null;
  });

  return state.connectingPromise;
}

/**
 * Starts connecting (idempotent). Waits up to `waitMs` for the first connection but never
 * throws: if RabbitMQ is down the process keeps running and reconnects in the background.
 */
export async function connectRabbitMQ({ waitMs = 5000 } = {}) {
  state.closing = false;
  if (!state.started) {
    state.started = true;
    establish().catch(() => {});
  }
  const deadline = Date.now() + waitMs;
  while (state.status !== 'connected' && Date.now() < deadline) await sleep(100);
  if (state.status !== 'connected') {
    logger.warn('RabbitMQ is not reachable yet (is the Docker container running?). Retrying in the background.');
  }
}

export function isBrokerConnected() {
  return state.status === 'connected' && Boolean(state.connection);
}

export function getConnection() {
  return state.connection;
}

export function getBrokerStatus() {
  return { status: state.status, ...(state.lastError && state.status !== 'connected' && { lastError: state.lastError }) };
}

/**
 * Publishes a persistent message and waits for the broker's publisher confirmation.
 * @throws {BrokerUnavailableError} when not connected; Error on nack/timeout
 */
export function publishConfirmed(exchange, routingKey, content, options = {}) {
  const channel = state.confirmChannel;
  if (!channel || state.status !== 'connected') return Promise.reject(new BrokerUnavailableError());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BrokerUnavailableError('Timed out waiting for RabbitMQ publisher confirmation')),
      config.rabbitmq.publishConfirmTimeoutMs
    );
    try {
      channel.publish(exchange, routingKey, content, { persistent: true, ...options }, (err) => {
        clearTimeout(timer);
        if (err) reject(new BrokerUnavailableError(`RabbitMQ rejected the message: ${err.message || err}`));
        else resolve();
      });
    } catch (err) {
      clearTimeout(timer);
      reject(new BrokerUnavailableError(err.message));
    }
  });
}

/** Message count of a queue (used for monitoring, e.g. DLQ depth). Returns null if unavailable. */
export async function getQueueDepth(queue) {
  const connection = state.connection;
  if (!connection) return null;
  let channel;
  try {
    channel = await connection.createChannel();
    channel.on('error', () => {});
    const info = await channel.checkQueue(queue);
    return { messages: info.messageCount, consumers: info.consumerCount };
  } catch {
    return null;
  } finally {
    try {
      await channel?.close();
    } catch {
      /* ignore */
    }
  }
}

export async function disconnectRabbitMQ() {
  state.closing = true;
  state.started = false;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const connection = state.connection;
  state.connection = null;
  state.confirmChannel = null;
  state.status = 'disconnected';
  if (connection) {
    try {
      await connection.close();
    } catch {
      /* already closed */
    }
  }
}
