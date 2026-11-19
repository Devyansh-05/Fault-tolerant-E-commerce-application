/** Escapes user input so it can be used literally inside a RegExp (prevents ReDoS/regex injection). */
export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

/** Builds a standard pagination envelope. */
export function paginate({ page, limit, total }) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
