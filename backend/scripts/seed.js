/**
 * Idempotent seed script:  npm run seed   (from the backend folder)
 *
 * - Products are upserted by slug with $setOnInsert, so re-running never creates duplicates
 *   and never resets stock that has changed through orders.
 * - Each product gets exactly one Inventory record (unique productId).
 * - If ADMIN_EMAIL and ADMIN_PASSWORD are set in backend/.env, an ADMIN account is created
 *   (an existing account with that email is promoted to ADMIN; its password is not changed).
 */
import { config } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Inventory, Product, User, USER_ROLES } from '../models/index.js';
import { hashPassword } from '../services/auth.service.js';
import { slugify } from '../utils/helpers.js';
import { sampleProducts } from './data/products.js';

async function seedProducts() {
  let inserted = 0;
  for (const data of sampleProducts) {
    const slug = slugify(data.name);
    const result = await Product.updateOne({ slug }, { $setOnInsert: { ...data, slug, isActive: true } }, { upsert: true });
    if (result.upsertedCount) inserted += 1;

    const product = await Product.findOne({ slug });
    await Inventory.updateOne(
      { productId: product._id },
      { $setOnInsert: { productId: product._id, availableQuantity: product.stock, reservedQuantity: 0 } },
      { upsert: true }
    );
  }
  console.log(`Products: ${inserted} inserted, ${sampleProducts.length - inserted} already present.`);
}

async function seedAdmin() {
  const { email, password, name } = config.admin;
  if (!email || !password) {
    console.log('Admin: skipped (set ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env to create one).');
    return;
  }
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');

  const normalizedEmail = email.toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    if (existing.role !== USER_ROLES.ADMIN) {
      existing.role = USER_ROLES.ADMIN;
      await existing.save();
      console.log(`Admin: existing user ${normalizedEmail} promoted to ADMIN.`);
    } else {
      console.log(`Admin: ${normalizedEmail} already exists.`);
    }
    return;
  }
  await User.create({ name, email: normalizedEmail, passwordHash: await hashPassword(password), role: USER_ROLES.ADMIN });
  console.log(`Admin: created ${normalizedEmail}.`);
}

try {
  await connectDatabase();
  console.log(`Seeding database "${config.mongo.dbName}"...`);
  await seedProducts();
  await seedAdmin();
  console.log('Seed complete.');
} catch (err) {
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
