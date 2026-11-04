'use strict';

const employeeService = require('../services/employeeService');
const logger = require('../utils/logger');
const {
  validateEmployeePayload,
  validateListQuery,
  validateId,
} = require('../validation/employeeValidation');

const CSV_COLUMNS = [
  ['id', 'ID'],
  ['firstName', 'First Name'],
  ['lastName', 'Last Name'],
  ['email', 'Email'],
  ['jobTitle', 'Job Title'],
  ['department', 'Department'],
  ['employmentType', 'Employment Type'],
  ['status', 'Status'],
  ['location', 'Location'],
  ['hireDate', 'Hire Date'],
  ['salary', 'Salary'],
];

function toCsvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function list(req, res) {
  const filters = validateListQuery(req.query);
  const result = await employeeService.listEmployees(filters);
  res.json(result);
}

async function exportCsv(req, res) {
  const filters = validateListQuery(req.query, { paginate: false });
  const employees = await employeeService.listEmployeesForExport(filters);

  const lines = [CSV_COLUMNS.map(([, header]) => header).join(',')];
  for (const employee of employees) {
    lines.push(CSV_COLUMNS.map(([key]) => toCsvCell(employee[key])).join(','));
  }

  const filename = `employees-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  // BOM so Excel opens UTF-8 names correctly.
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
}

async function getById(req, res) {
  const id = validateId(req.params.id);
  const employee = await employeeService.getEmployeeById(id);
  res.json({ data: employee });
}

async function create(req, res) {
  const payload = validateEmployeePayload(req.body);
  const employee = await employeeService.createEmployee(payload);
  logger.info('Employee created', { requestId: req.id, employeeId: employee.id });
  res.status(201).location(`/api/employees/${employee.id}`).json({ data: employee });
}

async function update(req, res) {
  const id = validateId(req.params.id);
  const payload = validateEmployeePayload(req.body);
  const employee = await employeeService.updateEmployee(id, payload);
  logger.info('Employee updated', { requestId: req.id, employeeId: employee.id });
  res.json({ data: employee });
}

async function remove(req, res) {
  const id = validateId(req.params.id);
  await employeeService.deleteEmployee(id);
  logger.info('Employee deleted', { requestId: req.id, employeeId: Number(id) });
  res.status(204).end();
}

module.exports = { list, exportCsv, getById, create, update, remove };
