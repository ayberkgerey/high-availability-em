'use strict';

const { listDepartments } = require('../services/departmentService');

async function list(req, res) {
  const departments = await listDepartments();
  res.json({ data: departments });
}

module.exports = { list };
