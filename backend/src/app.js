'use strict';

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const requestContext = require('./middleware/requestContext');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { apiRouter, healthRouter } = require('./routes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind the ALB: trust exactly one proxy hop for req.ip / X-Forwarded-Proto.
  app.set('trust proxy', 1);

  app.use(requestContext);
  // Health checks are mounted before body parsing, static files and the API so they stay cheap.
  app.use(healthRouter);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Inline style attributes are used for dynamic avatar colors and chart widths; scripts stay 'self' only.
          styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // The ALB listener may be plain HTTP in a portfolio setup.
          upgradeInsecureRequests: null,
        },
      },
      // HSTS only makes sense once the ALB terminates TLS.
      strictTransportSecurity: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '50kb' }));

  app.use('/api', apiRouter);
  app.use('/api', notFoundHandler);

  app.use(
    express.static(config.frontendDir, {
      index: 'index.html',
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
