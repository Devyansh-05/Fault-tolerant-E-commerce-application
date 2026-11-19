import mongoose from 'mongoose';
import { config } from '../../config/env.js';

/**
 * Empties every collection in the TEST database.
 * (Atlas "readWrite" users may not call dropDatabase, but deleteMany is allowed.
 * Collections and their unique indexes are kept, which the tests rely on.)
 */
export async function clearTestDatabase() {
  if (!/test/i.test(config.mongo.dbName) || mongoose.connection.name !== config.mongo.dbName) {
    throw new Error(`Refusing to clear non-test database "${mongoose.connection.name}"`);
  }
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
