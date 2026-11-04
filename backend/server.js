'use strict';

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { createApp } = require('./src/app');
const { getPool, ping, closePool } = require('./src/db/pool');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info('PeopleDesk server started', {
    port: config.port,
    env: config.env,
    nodeVersion: process.version,
    credentialSource: config.aws.secretName ? 'secrets-manager' : 'env',
  });
});

// The ALB idle timeout defaults to 60s; Node must keep idle connections open longer,
// otherwise the ALB can reuse a socket Node already closed and return 502s.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Warm up the pool in the background. Startup never fails because the database is down:
// /health stays green and requests recover automatically once Aurora is reachable.
(async () => {
  try {
    await getPool();
    const { latencyMs, readOnly } = await ping();
    logger.info('Database connection verified', { latencyMs, role: readOnly ? 'reader' : 'writer' });
  } catch (err) {
    logger.warn('Database not reachable at startup; will retry on demand', {
      code: err.code,
      reason: err.message,
    });
  }
})();

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutdown signal received, draining connections', { signal });

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  server.close(async () => {
    try {
      await closePool();
    } catch (err) {
      logger.warn('Error closing database pool', { error: err });
    }
    logger.info('Shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason instanceof Error ? reason : String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception, exiting so systemd can restart the process', { error: err });
  process.exit(1);
});
