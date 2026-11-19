import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins/toJSON.js';

export const USER_ROLES = Object.freeze({ CUSTOMER: 'CUSTOMER', ADMIN: 'ADMIN' });

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true, // enforced by a unique index
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    // bcrypt hash only — plain-text passwords are never stored. Excluded from queries by default.
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: Object.values(USER_ROLES),
      default: USER_ROLES.CUSTOMER,
      index: true,
    },
    // The synthetic test customer owned by the Stage 3 event generator (cannot log in).
    isSynthetic: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.plugin(toJSONPlugin, { hidden: ['passwordHash'] });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
