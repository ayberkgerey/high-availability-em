'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const employeeRoutes = require('./employeeRoutes');
const dashboardController = require('../controllers/dashboardController');
const departmentController = require('../controllers/departmentController');
const healthController = require('../controllers/healthController');

const apiRouter = express.Router();

apiRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

apiRouter.get('/dashboard', asyncHandler(dashboardController.getDashboard));
apiRouter.get('/departments', asyncHandler(departmentController.list));
apiRouter.get('/instance', asyncHandler(healthController.instance));
apiRouter.use('/employees', employeeRoutes);

const healthRouter = express.Router();
healthRouter.get('/health', healthController.health);
healthRouter.get('/ready', asyncHandler(healthController.ready));

module.exports = { apiRouter, healthRouter };
