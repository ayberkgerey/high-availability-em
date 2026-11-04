'use strict';

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { isDatabaseUnavailableError } = require('../db/pool');

function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl.split('?')[0]} not found`,
      requestId: req.id,
    },
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    logger.error('Error after response headers were sent', { requestId: req.id, error: err });
    res.destroy();
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error(err.message, { requestId: req.id, error: err });
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: req.id },
    });
    return;
  }

  if (err.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON', requestId: req.id },
    });
    return;
  }

  if (err.type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', requestId: req.id },
    });
    return;
  }

  if (isDatabaseUnavailableError(err)) {
    res.set('Retry-After', '5');
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'The database is temporarily unavailable. Please try again in a few seconds.',
        requestId: req.id,
      },
    });
    return;
  }

  // Internal details (SQL, stack traces, hostnames) are logged, never returned.
  logger.error('Unhandled error', { requestId: req.id, error: err });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: req.id },
  });
}

module.exports = { errorHandler, notFoundHandler };
