/**
 * Shared JSON serialisation: exposes `id` instead of `_id`, removes `__v`,
 * and strips any field listed in `hidden`.
 */
export function toJSONPlugin(schema, { hidden = [] } = {}) {
  const transform = (doc, ret) => {
    if (ret._id !== undefined) {
      ret.id = String(ret._id);
      delete ret._id;
    }
    delete ret.__v;
    for (const field of hidden) delete ret[field];
    return ret;
  };
  schema.set('toJSON', { virtuals: false, versionKey: false, transform });
  schema.set('toObject', { virtuals: false, versionKey: false, transform });
}
