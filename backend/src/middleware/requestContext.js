'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { getInstanceInfo } = require('../services/instanceService');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9=;.\-]{1,128}$/;
const QUIET_PATHS = new Set(['/health', '/ready']);

let servedBy = null;
getInstanceInfo()
  .then((info) => {
    servedBy = info.instanceId ? `${info.instanceId} (${info.availabilityZone})` : info.hostname;
  })
  .catch(() => {});

/**
 * Assigns a request id (reusing the ALB X-Amzn-Trace-Id when present),
 * exposes which instance served the request, and logs each completed request.
 */
function requestContext(req, res, next) {
  const incoming = req.get('x-request-id') || req.get('x-amzn-trace-id');
  req.id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();

  res.set('X-Request-Id', req.id);
  if (servedBy) res.set('X-Served-By', servedBy);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const meta = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      clientIp: req.ip,
      userAgent: req.get('user-agent'),
    };

    if (res.statusCode >= 500) logger.error('Request failed', meta);
    else if (QUIET_PATHS.has(meta.path) || !meta.path.startsWith('/api')) logger.debug('Request completed', meta);
    else logger.info('Request completed', meta);
  });

  next();
}

module.exports = requestContext;
