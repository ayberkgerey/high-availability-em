'use strict';

const fs = require('fs');
const mysql = require('mysql2/promise');
const config = require('../config');
const { getDatabaseCredentials } = require('../config/secrets');
const logger = require('../utils/logger');
const { ServiceUnavailableError } = require('../utils/errors');

// Errors raised before the statement reached the server: always safe to retry.
const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ER_CON_COUNT_ERROR',
  'ER_SERVER_SHUTDOWN',
  'ER_OPTION_PREVENTS_STATEMENT', // writer demoted to reader during Aurora failover (--read-only)
]);

// Connection dropped mid-flight: the statement may or may not have been applied,
// so only idempotent (read) queries are retried.
const IN_FLIGHT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_CONNECTION_KILLED',
  'ER_QUERY_INTERRUPTED',
]);

const AUTH_ERROR_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR']);
const CREDENTIAL_REFRESH_INTERVAL_MS = 30000;

let pool = null;
let poolPromise = null;
let lastCredentialRefresh = 0;

function buildSslOptions() {
  if (!config.db.ssl) return undefined;
  if (config.db.sslCaPath) {
    return { ca: fs.readFileSync(config.db.sslCaPath, 'utf8'), rejectUnauthorized: true };
  }
  // mysql2 ships the Amazon RDS certificate bundle as a named SSL profile.
  return 'Amazon RDS';
}

async function createPool() {
  const credentials = await getDatabaseCredentials();

  const newPool = mysql.createPool({
    host: credentials.host,
    port: credentials.port,
    user: credentials.user,
    password: credentials.password,
    database: credentials.database,
    ssl: buildSslOptions(),
    waitForConnections: true,
    connectionLimit: config.db.poolSize,
    maxIdle: config.db.maxIdle,
    idleTimeout: config.db.idleTimeoutMs,
    queueLimit: config.db.queueLimit,
    connectTimeout: config.db.connectTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    timezone: 'Z',
    charset: 'utf8mb4',
    decimalNumbers: true,
    namedPlaceholders: false,
  });

  newPool.on('connection', (connection) => {
    logger.debug('Opened new database connection', { threadId: connection.threadId });
  });

  logger.info('Database connection pool created', {
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    connectionLimit: config.db.poolSize,
    ssl: Boolean(config.db.ssl),
  });

  pool = newPool;
  return newPool;
}

async function getPool() {
  if (pool) return pool;
  if (!poolPromise) {
    poolPromise = createPool().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

async function resetPool(reason) {
  const oldPool = pool;
  pool = null;
  poolPromise = null;
  logger.warn('Resetting database connection pool', { reason });
  if (oldPool) {
    oldPool.end().catch((err) => logger.warn('Error while closing old pool', { error: err }));
  }
}

function isConnectError(err) {
  return Boolean(err && CONNECT_ERROR_CODES.has(err.code));
}

function isInFlightError(err) {
  return Boolean(err && (IN_FLIGHT_ERROR_CODES.has(err.code) || err.fatal));
}

/** True for any error caused by database unavailability (used to map errors to HTTP 503). */
function isDatabaseUnavailableError(err) {
  if (!err) return false;
  return (
    isConnectError(err) ||
    isInFlightError(err) ||
    AUTH_ERROR_CODES.has(err.code) ||
    err.message === 'Queue limit reached.' ||
    err.name === 'CredentialsProviderError' ||
    err.name === 'ResourceNotFoundException' ||
    err.$metadata !== undefined // any AWS SDK error while loading the secret
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes a parameterized statement using a pooled connection.
 * Transient connectivity errors (e.g. during Aurora failover) are retried with
 * exponential backoff. Writes are only retried when the statement never reached the server.
 */
async function query(sql, params = [], { idempotent = true } = {}) {
  const maxAttempts = Math.max(1, config.db.queryRetries + 1);

  for (let attempt = 1; ; attempt += 1) {
    let connection;
    try {
      const activePool = await getPool();
      connection = await activePool.getConnection();
      const [rows] = await connection.execute(sql, params);
      connection.release();
      return rows;
    } catch (err) {
      if (connection) {
        // Never return a broken or read-only (demoted writer) connection to the pool:
        // a fresh connection re-resolves the cluster endpoint DNS to the new writer.
        if (err.fatal || err.code === 'ER_OPTION_PREVENTS_STATEMENT') connection.destroy();
        else connection.release();
      }

      if (AUTH_ERROR_CODES.has(err.code) && config.aws.secretName) {
        // The secret may have been rotated: reload it at most once per interval.
        const now = Date.now();
        if (now - lastCredentialRefresh > CREDENTIAL_REFRESH_INTERVAL_MS) {
          lastCredentialRefresh = now;
          await resetPool('authentication failed, reloading credentials from Secrets Manager');
          if (attempt < maxAttempts) continue;
        }
      }

      const retryable = isConnectError(err) || (idempotent && isInFlightError(err));
      if (!retryable || attempt >= maxAttempts) {
        if (isDatabaseUnavailableError(err)) {
          logger.error('Database unavailable', { error: err, attempts: attempt });
        }
        throw err;
      }

      const delay = Math.min(config.db.retryBaseDelayMs * 2 ** (attempt - 1), 4000);
      logger.warn('Transient database error, retrying', {
        code: err.code,
        attempt,
        maxAttempts,
        retryInMs: delay,
      });
      await sleep(delay);
    }
  }
}

/** Lightweight connectivity check for the /ready endpoint. Never retries. */
async function ping() {
  const timeoutMs = config.db.readyTimeoutMs;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ServiceUnavailableError('Database ping timed out')), timeoutMs);
  });

  const check = (async () => {
    const activePool = await getPool();
    const started = Date.now();
    const [rows] = await activePool.query({ sql: 'SELECT 1 AS ok, @@innodb_read_only AS readOnly', timeout: timeoutMs });
    return { latencyMs: Date.now() - started, readOnly: Boolean(Number(rows[0].readOnly)) };
  })();

  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  poolPromise = null;
  await current.end();
  logger.info('Database connection pool closed');
}

module.exports = {
  query,
  ping,
  getPool,
  closePool,
  isDatabaseUnavailableError,
};
