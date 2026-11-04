'use strict';

class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details) {
    super(409, 'CONFLICT', message, details);
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable. Please retry shortly.') {
    super(503, 'SERVICE_UNAVAILABLE', message);
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
};
