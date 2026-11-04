'use strict';

const { ValidationError } = require('../utils/errors');

const EMPLOYMENT_TYPES = Object.freeze(['Full-time', 'Part-time', 'Contract']);
const EMPLOYMENT_STATUSES = Object.freeze(['Active', 'On Leave', 'Inactive']);
const SORT_FIELDS = Object.freeze(['name', 'hireDate', 'createdAt']);
const SORT_ORDERS = Object.freeze(['asc', 'desc']);

const MAX_PAGE_SIZE = 100;
const MAX_SALARY = 99999999.99;

const NAME_PATTERN = /^[\p{L}\p{M}' .-]+$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[1-9]\d{0,15}$/;

function readString(body, field, label, { min = 1, max, pattern, patternMessage }, errors) {
  const raw = body[field];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    errors.push({ field, message: `${label} is required` });
    return undefined;
  }
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${label} must be a string` });
    return undefined;
  }
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < min || value.length > max) {
    errors.push({ field, message: `${label} must be between ${min} and ${max} characters` });
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    errors.push({ field, message: patternMessage || `${label} has an invalid format` });
    return undefined;
  }
  return value;
}

function readEnum(body, field, label, allowed, errors) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    errors.push({ field, message: `${label} is required` });
    return undefined;
  }
  if (!allowed.includes(value)) {
    errors.push({ field, message: `${label} must be one of: ${allowed.join(', ')}` });
    return undefined;
  }
  return value;
}

function isValidCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function readHireDate(body, errors) {
  const value = body.hireDate;
  if (!value) {
    errors.push({ field: 'hireDate', message: 'Hire date is required' });
    return undefined;
  }
  if (typeof value !== 'string' || !isValidCalendarDate(value)) {
    errors.push({ field: 'hireDate', message: 'Hire date must be a valid date (YYYY-MM-DD)' });
    return undefined;
  }
  const maxDate = new Date();
  maxDate.setUTCFullYear(maxDate.getUTCFullYear() + 1);
  if (value < '1950-01-01' || value > maxDate.toISOString().slice(0, 10)) {
    errors.push({ field: 'hireDate', message: 'Hire date must be between 1950 and one year from today' });
    return undefined;
  }
  return value;
}

function readSalary(body, errors) {
  const raw = body.salary;
  if (raw === undefined || raw === null || raw === '') {
    errors.push({ field: 'salary', message: 'Salary is required' });
    return undefined;
  }
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field: 'salary', message: 'Salary must be a number' });
    return undefined;
  }
  if (value < 0 || value > MAX_SALARY) {
    errors.push({ field: 'salary', message: `Salary must be between 0 and ${MAX_SALARY}` });
    return undefined;
  }
  if (Math.round(value * 100) !== Number((value * 100).toFixed(6))) {
    errors.push({ field: 'salary', message: 'Salary can have at most two decimal places' });
    return undefined;
  }
  return Math.round(value * 100) / 100;
}

/** Validates and normalizes an employee payload (used for both POST and PUT). */
function validateEmployeePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const errors = [];
  const value = {
    firstName: readString(body, 'firstName', 'First name', {
      max: 100,
      pattern: NAME_PATTERN,
      patternMessage: 'First name may only contain letters, spaces, apostrophes, dots and hyphens',
    }, errors),
    lastName: readString(body, 'lastName', 'Last name', {
      max: 100,
      pattern: NAME_PATTERN,
      patternMessage: 'Last name may only contain letters, spaces, apostrophes, dots and hyphens',
    }, errors),
    email: readString(body, 'email', 'Email', {
      min: 5,
      max: 255,
      pattern: EMAIL_PATTERN,
      patternMessage: 'Email must be a valid email address',
    }, errors),
    jobTitle: readString(body, 'jobTitle', 'Job title', { min: 2, max: 150 }, errors),
    department: readString(body, 'department', 'Department', { max: 100 }, errors),
    employmentType: readEnum(body, 'employmentType', 'Employment type', EMPLOYMENT_TYPES, errors),
    status: readEnum(body, 'status', 'Employment status', EMPLOYMENT_STATUSES, errors),
    hireDate: readHireDate(body, errors),
    location: readString(body, 'location', 'Location', { min: 2, max: 150 }, errors),
    salary: readSalary(body, errors),
  };

  if (errors.length > 0) throw new ValidationError('Employee data is invalid', errors);

  value.email = value.email.toLowerCase();
  return value;
}

function parsePositiveInt(raw, field, fallback, max, errors) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || (max && value > max)) {
    errors.push({ field, message: `${field} must be an integer between 1 and ${max || 'infinity'}` });
    return fallback;
  }
  return value;
}

function optionalString(raw, field, max, errors) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be a single value` });
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) {
    errors.push({ field, message: `${field} must be at most ${max} characters` });
    return undefined;
  }
  return value || undefined;
}

/** Validates list/export query string parameters. */
function validateListQuery(query, { paginate = true } = {}) {
  const errors = [];

  const status = optionalString(query.status, 'status', 20, errors);
  if (status && !EMPLOYMENT_STATUSES.includes(status)) {
    errors.push({ field: 'status', message: `status must be one of: ${EMPLOYMENT_STATUSES.join(', ')}` });
  }

  const sortBy = optionalString(query.sortBy, 'sortBy', 20, errors) || 'name';
  if (!SORT_FIELDS.includes(sortBy)) {
    errors.push({ field: 'sortBy', message: `sortBy must be one of: ${SORT_FIELDS.join(', ')}` });
  }

  const sortOrder = (optionalString(query.sortOrder, 'sortOrder', 4, errors) || 'asc').toLowerCase();
  if (!SORT_ORDERS.includes(sortOrder)) {
    errors.push({ field: 'sortOrder', message: 'sortOrder must be asc or desc' });
  }

  const result = {
    search: optionalString(query.search, 'search', 100, errors),
    department: optionalString(query.department, 'department', 100, errors),
    status,
    sortBy,
    sortOrder,
  };

  if (paginate) {
    result.page = parsePositiveInt(query.page, 'page', 1, 100000, errors);
    result.pageSize = parsePositiveInt(query.pageSize, 'pageSize', 10, MAX_PAGE_SIZE, errors);
  }

  if (errors.length > 0) throw new ValidationError('Invalid query parameters', errors);
  return result;
}

function validateId(raw) {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    throw new ValidationError('Employee id must be a positive integer', [
      { field: 'id', message: 'Employee id must be a positive integer' },
    ]);
  }
  return raw;
}

module.exports = {
  EMPLOYMENT_TYPES,
  EMPLOYMENT_STATUSES,
  validateEmployeePayload,
  validateListQuery,
  validateId,
};
