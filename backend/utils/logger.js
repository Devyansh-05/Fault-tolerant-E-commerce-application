/**
 * Minimal structured console logger. Kept dependency-free on purpose; it can be
 * swapped for a full logging library later without touching call sites.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold =
  LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'test' ? LEVELS.error : LEVELS.info);

function write(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) out(line, meta);
  else out(line);
}

export const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
