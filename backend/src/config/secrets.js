'use strict';

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const config = require('./index');
const logger = require('../utils/logger');

let client;

function getClient() {
  if (!client) {
    // Credentials are resolved by the SDK default provider chain,
    // which uses the EC2 instance profile (IAM role) via IMDSv2 on AWS.
    client = new SecretsManagerClient({ region: config.aws.region });
  }
  return client;
}

async function fetchSecret(secretName) {
  const response = await getClient().send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!response.SecretString) {
    throw new Error(`Secret "${secretName}" has no SecretString value`);
  }

  try {
    return JSON.parse(response.SecretString);
  } catch {
    throw new Error(`Secret "${secretName}" is not valid JSON`);
  }
}

/**
 * Returns the database connection settings.
 * - AWS_SECRET_NAME set: values from Secrets Manager, falling back to env vars for
 *   fields the secret does not contain (e.g. RDS-managed secrets only hold username/password).
 * - Otherwise: values from environment variables / local .env file.
 */
async function getDatabaseCredentials() {
  const fromEnv = {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  };

  if (!config.aws.secretName) {
    logger.info('Using database credentials from environment variables', {
      source: 'env',
      host: fromEnv.host,
      database: fromEnv.database,
    });
    return fromEnv;
  }

  const secret = await fetchSecret(config.aws.secretName);
  const credentials = {
    host: secret.host || fromEnv.host,
    port: Number.parseInt(secret.port, 10) || fromEnv.port,
    user: secret.username || secret.user || fromEnv.user,
    password: secret.password || fromEnv.password,
    database: secret.database || secret.dbname || fromEnv.database,
  };

  logger.info('Loaded database credentials from AWS Secrets Manager', {
    source: 'secrets-manager',
    secretName: config.aws.secretName,
    host: credentials.host,
    database: credentials.database,
  });

  return credentials;
}

module.exports = { getDatabaseCredentials };
