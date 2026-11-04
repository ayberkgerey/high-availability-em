'use strict';

const { query } = require('../db/pool');

async function listDepartments() {
  const rows = await query(`
    SELECT d.id,
           d.name,
           d.description,
           COUNT(e.id)                         AS employeeCount,
           COALESCE(SUM(e.status = 'Active'), 0) AS activeCount
      FROM departments d
      LEFT JOIN employees e ON e.department = d.name
     GROUP BY d.id, d.name, d.description
     ORDER BY d.name ASC`);

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    description: row.description,
    employeeCount: Number(row.employeeCount),
    activeCount: Number(row.activeCount),
  }));
}

module.exports = { listDepartments };
