'use strict';

const { getDashboardStats } = require('../services/dashboardService');

async function getDashboard(req, res) {
  const stats = await getDashboardStats();
  res.json({ data: stats });
}

module.exports = { getDashboard };
