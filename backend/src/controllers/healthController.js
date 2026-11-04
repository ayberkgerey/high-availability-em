'use strict';

const { ping } = require('../db/pool');
const { getInstanceInfo } = require('../services/instanceService');
const logger = require('../utils/logger');

const startedAt = Date.now();

/** Liveness: process is up. Intentionally independent of the database (ALB health check). */
function health(req, res) {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
}

/** Readiness: process can reach Aurora. */
async function ready(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const { latencyMs, readOnly } = await ping();
    res.status(200).json({
      status: 'ready',
      database: { status: 'connected', latencyMs, role: readOnly ? 'reader' : 'writer' },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('Readiness check failed', { requestId: req.id, code: err.code, reason: err.message });
    res.status(503).json({
      status: 'not_ready',
      database: { status: 'unavailable' },
      timestamp: new Date().toISOString(),
    });
  }
}

async function instance(req, res) {
  const info = await getInstanceInfo();
  res.set('Cache-Control', 'no-store');
  res.json({
    data: {
      ...info,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    },
  });
}

module.exports = { health, ready, instance };
