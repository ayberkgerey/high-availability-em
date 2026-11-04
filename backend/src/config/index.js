'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Local development only. On EC2 the values come from the systemd EnvironmentFile,
// and dotenv never overrides variables that are already set.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: toInt(process.env.PORT, 3000),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  frontendDir: process.env.FRONTEND_DIR
    ? path.resolve(process.env.FRONTEND_DIR)
    : path.resolve(__dirname, '../../../frontend'),
  shutdownTimeoutMs: toInt(process.env.SHUTDOWN_TIMEOUT_MS, 15000),
  ec2MetadataEnabled: toBool(process.env.EC2_METADATA_ENABLED, true),

  aws: Object.freeze({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined,
    secretName: process.env.AWS_SECRET_NAME || '',
  }),

  db: Object.freeze({
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'employee_management',
    ssl: toBool(process.env.DB_SSL, false),
    sslCaPath: process.env.DB_SSL_CA_PATH || '',
    poolSize: toInt(process.env.DB_POOL_SIZE, 10),
    maxIdle: toInt(process.env.DB_POOL_MAX_IDLE, 5),
    idleTimeoutMs: toInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 60000),
    queueLimit: toInt(process.env.DB_POOL_QUEUE_LIMIT, 100),
    connectTimeoutMs: toInt(process.env.DB_CONNECT_TIMEOUT_MS, 5000),
    queryRetries: toInt(process.env.DB_QUERY_RETRIES, 3),
    retryBaseDelayMs: toInt(process.env.DB_RETRY_BASE_DELAY_MS, 250),
    readyTimeoutMs: toInt(process.env.DB_READY_TIMEOUT_MS, 3000),
  }),
});

module.exports = config;
