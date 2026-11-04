'use strict';

const { query } = require('../db/pool');
const { NotFoundError, ConflictError, ValidationError } = require('../utils/errors');

const SELECT_COLUMNS = `
  e.id,
  e.first_name,
  e.last_name,
  e.email,
  e.job_title,
  e.department,
  e.employment_type,
  e.status,
  e.salary,
  DATE_FORMAT(e.hire_date, '%Y-%m-%d') AS hire_date,
  e.location,
  e.created_at,
  e.updated_at`;

// ORDER BY cannot be parameterized, so only whitelisted expressions are ever used.
const SORT_COLUMNS = Object.freeze({
  name: { asc: 'e.last_name ASC, e.first_name ASC, e.id ASC', desc: 'e.last_name DESC, e.first_name DESC, e.id DESC' },
  hireDate: { asc: 'e.hire_date ASC, e.id ASC', desc: 'e.hire_date DESC, e.id DESC' },
  createdAt: { asc: 'e.created_at ASC, e.id ASC', desc: 'e.created_at DESC, e.id DESC' },
});

const EXPORT_ROW_LIMIT = 10000;

function toEmployee(row) {
  return {
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`,
    email: row.email,
    jobTitle: row.job_title,
    department: row.department,
    employmentType: row.employment_type,
    status: row.status,
    salary: Number(row.salary),
    hireDate: row.hire_date,
    location: row.location,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function buildWhereClause({ search, department, status }) {
  const conditions = [];
  const params = [];

  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      "(CONCAT(e.first_name, ' ', e.last_name) LIKE ? OR e.email LIKE ? OR e.job_title LIKE ?)",
    );
    params.push(pattern, pattern, pattern);
  }
  if (department) {
    conditions.push('e.department = ?');
    params.push(department);
  }
  if (status) {
    conditions.push('e.status = ?');
    params.push(status);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function translateWriteError(err) {
  if (err.code === 'ER_DUP_ENTRY') {
    return new ConflictError('An employee with this email already exists', [
      { field: 'email', message: 'This email is already in use' },
    ]);
  }
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_NO_REFERENCED_ROW') {
    return new ValidationError('Employee data is invalid', [
      { field: 'department', message: 'Department does not exist' },
    ]);
  }
  if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    return new ValidationError('Employee data violates a database constraint');
  }
  return err;
}

async function listEmployees(filters) {
  const { where, params } = buildWhereClause(filters);
  const orderBy = SORT_COLUMNS[filters.sortBy][filters.sortOrder];
  const offset = (filters.page - 1) * filters.pageSize;

  const [countRows, rows] = await Promise.all([
    query(`SELECT COUNT(*) AS total FROM employees e ${where}`, params),
    // LIMIT/OFFSET are sent as strings: required by MySQL 8 prepared statements via mysql2.
    query(
      `SELECT ${SELECT_COLUMNS} FROM employees e ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, String(filters.pageSize), String(offset)],
    ),
  ]);

  const total = Number(countRows[0].total);
  return {
    data: rows.map(toEmployee),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

async function listEmployeesForExport(filters) {
  const { where, params } = buildWhereClause(filters);
  const orderBy = SORT_COLUMNS[filters.sortBy][filters.sortOrder];
  const rows = await query(
    `SELECT ${SELECT_COLUMNS} FROM employees e ${where} ORDER BY ${orderBy} LIMIT ?`,
    [...params, String(EXPORT_ROW_LIMIT)],
  );
  return rows.map(toEmployee);
}

async function getEmployeeById(id) {
  const rows = await query(`SELECT ${SELECT_COLUMNS} FROM employees e WHERE e.id = ?`, [id]);
  if (rows.length === 0) throw new NotFoundError(`Employee ${id} was not found`);
  return toEmployee(rows[0]);
}

async function createEmployee(data) {
  let result;
  try {
    result = await query(
      `INSERT INTO employees
        (first_name, last_name, email, job_title, department, employment_type, status, salary, hire_date, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.firstName,
        data.lastName,
        data.email,
        data.jobTitle,
        data.department,
        data.employmentType,
        data.status,
        data.salary,
        data.hireDate,
        data.location,
      ],
      { idempotent: false },
    );
  } catch (err) {
    throw translateWriteError(err);
  }
  return getEmployeeById(String(result.insertId));
}

async function updateEmployee(id, data) {
  try {
    await query(
      `UPDATE employees
          SET first_name = ?, last_name = ?, email = ?, job_title = ?, department = ?,
              employment_type = ?, status = ?, salary = ?, hire_date = ?, location = ?
        WHERE id = ?`,
      [
        data.firstName,
        data.lastName,
        data.email,
        data.jobTitle,
        data.department,
        data.employmentType,
        data.status,
        data.salary,
        data.hireDate,
        data.location,
        id,
      ],
      { idempotent: false },
    );
  } catch (err) {
    throw translateWriteError(err);
  }

  // affectedRows is 0 both for "not found" and "no changes", so existence is checked
  // by re-reading the row, which throws NotFoundError when it does not exist.
  return getEmployeeById(id);
}

async function deleteEmployee(id) {
  const result = await query('DELETE FROM employees WHERE id = ?', [id], { idempotent: false });
  if (result.affectedRows === 0) throw new NotFoundError(`Employee ${id} was not found`);
}

module.exports = {
  listEmployees,
  listEmployeesForExport,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
};
