'use strict';

const os = require('os');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const hostname = os.hostname();

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    errno: err.errno,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  };
}

function write(level, message, meta = {}) {
  if (LEVELS[level] < configuredLevel) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    hostname,
    pid: process.pid,
  };

  for (const [key, value] of Object.entries(meta)) {
    entry[key] = value instanceof Error ? serializeError(value) : value;
  }

  // One JSON object per line so journald / CloudWatch Logs can parse it.
  const line = JSON.stringify(entry);
  if (LEVELS[level] >= LEVELS.error) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

module.exports = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
