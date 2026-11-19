/**
 * MongoDB Atlas connection + transaction helper.
 *
 * Multi-document ACID transactions require a replica set or sharded cluster.
 * Every Atlas cluster (including the free M0 tier) is a replica set, but we verify it
 * at startup instead of assuming. If transactions are unavailable, order creation
 * refuses to run (HTTP 503) — it never silently falls back to non-atomic writes.
 */
import mongoose from 'mongoose';
import { config } from './env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/AppError.js';
import '../models/index.js'; // registers all models so ensureIndexes() can see them

let transactionsSupported = false;

const READY_STATES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

export async function connectDatabase() {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error(`MongoDB error: ${err.message}`));

  await mongoose.connect(config.mongo.uri, {
    dbName: config.mongo.dbName,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 15000,
    retryWrites: true,
  });

  transactionsSupported = await detectTransactionSupport();
  if (transactionsSupported) {
    logger.info(`MongoDB connected (database "${config.mongo.dbName}", transactions supported)`);
  } else {
    logger.error(
      'MongoDB connected, but the deployment does NOT support multi-document transactions. ' +
        'Order creation is disabled. Use a MongoDB Atlas cluster (replica set).'
    );
  }

  // Make sure collections and unique indexes (e.g. order idempotency key) exist
  // before the first request arrives, so uniqueness is enforced from the start.
  await ensureIndexes();
}

async function detectTransactionSupport() {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  const isReplicaSet = Boolean(hello.setName);
  const isSharded = hello.msg === 'isdbgrid';
  return (isReplicaSet || isSharded) && hello.logicalSessionTimeoutMinutes != null;
}

export async function ensureIndexes() {
  for (const model of Object.values(mongoose.models)) {
    try {
      await model.createCollection();
    } catch (err) {
      if (err.code !== 48) throw err; // 48 = NamespaceExists
    }
    await model.createIndexes();
  }
}

export function isTransactionSupported() {
  return transactionsSupported;
}

export function getDatabaseStatus() {
  return {
    status: READY_STATES[mongoose.connection.readyState] ?? 'unknown',
    transactionsSupported,
  };
}

/**
 * Runs `work(session)` inside a MongoDB transaction. The driver automatically retries
 * the whole callback on TransientTransactionError (e.g. write conflicts) and retries the
 * commit on UnknownTransactionCommitResult, so `work` must be safe to re-run — it must
 * only perform database operations through the given session.
 *
 * Service-layer modules (orders now; outbox/consumers in Stage 2) use this helper.
 */
export async function runInTransaction(work) {
  if (!transactionsSupported) {
    throw new AppError(
      503,
      'TRANSACTIONS_UNAVAILABLE',
      'The database does not support transactions; this operation cannot be performed safely.'
    );
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      }
    );
    return result;
  } finally {
    await session.endSession();
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
