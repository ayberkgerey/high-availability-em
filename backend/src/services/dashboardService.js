'use strict';

const { query } = require('../db/pool');

async function getDashboardStats() {
  const [totalsRows, departmentRows, recentRows] = await Promise.all([
    query(`
      SELECT
        COUNT(*)                                     AS totalEmployees,
        COALESCE(SUM(status = 'Active'), 0)          AS activeEmployees,
        COALESCE(SUM(status = 'On Leave'), 0)        AS employeesOnLeave,
        COALESCE(SUM(status = 'Inactive'), 0)        AS inactiveEmployees,
        (SELECT COUNT(*) FROM departments)           AS totalDepartments
      FROM employees`),
    query(`
      SELECT d.name AS department, COUNT(e.id) AS headcount
        FROM departments d
        LEFT JOIN employees e ON e.department = d.name
       GROUP BY d.name
       ORDER BY headcount DESC, d.name ASC`),
    query(`
      SELECT id, first_name, last_name, job_title, department, DATE_FORMAT(hire_date, '%Y-%m-%d') AS hire_date
        FROM employees
       ORDER BY hire_date DESC, id DESC
       LIMIT 5`),
  ]);

  const totals = totalsRows[0];
  return {
    totalEmployees: Number(totals.totalEmployees),
    activeEmployees: Number(totals.activeEmployees),
    employeesOnLeave: Number(totals.employeesOnLeave),
    inactiveEmployees: Number(totals.inactiveEmployees),
    totalDepartments: Number(totals.totalDepartments),
    departmentBreakdown: departmentRows.map((row) => ({
      department: row.department,
      headcount: Number(row.headcount),
    })),
    recentHires: recentRows.map((row) => ({
      id: Number(row.id),
      fullName: `${row.first_name} ${row.last_name}`,
      jobTitle: row.job_title,
      department: row.department,
      hireDate: row.hire_date,
    })),
  };
}

module.exports = { getDashboardStats };
