'use strict';

/**
 * Applies database/schema.sql (database, tables, indexes and sample data).
 * Uses the same credential resolution as the app (.env or AWS Secrets Manager),
 * so it can be run locally or once from an EC2 instance:
 *
 *   npm run db:init
 *
 * The user needs CREATE privileges; the script is idempotent.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { getDatabaseCredentials } = require('../src/config/secrets');

async function main() {
  const schemaPath = path.resolve(__dirname, '../../database/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const credentials = await getDatabaseCredentials();

  const connection = await mysql.createConnection({
    host: credentials.host,
    port: credentials.port,
    user: credentials.user,
    password: credentials.password,
    multipleStatements: true,
    connectTimeout: config.db.connectTimeoutMs,
    ssl: config.db.ssl
      ? config.db.sslCaPath
        ? { ca: fs.readFileSync(config.db.sslCaPath, 'utf8'), rejectUnauthorized: true }
        : 'Amazon RDS'
      : undefined,
  });

  try {
    await connection.query(sql);
    const [[{ employees }]] = await connection.query(
      'SELECT COUNT(*) AS employees FROM employee_management.employees',
    );
    console.log(`Schema applied successfully. employees table contains ${employees} rows.`);
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(`Database initialization failed: ${err.code || ''} ${err.message}`);
  process.exit(1);
});
