// Standardized Application Error Class
// Provides consistent error handling across the application

class AppError extends Error {
  /**
   * Creates a new application error
   * @param {string} message - Human-readable error message
   * @param {number} statusCode - HTTP status code
   * @param {string} errorCode - Machine-readable error code
   * @param {boolean} isOperational - Whether error is operational (expected) or programming error
   * @param {Object} metadata - Additional context for debugging
   */
  constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR', isOperational = true, metadata = {}) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.metadata = metadata;
    this.timestamp = new Date().toISOString();

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to safe JSON for client response
   * @returns {Object} Safe error object (no internal details)
   */
  toJSON() {
    return {
      error: this.message,
      code: this.errorCode,
      timestamp: this.timestamp
    };
  }

  /**
   * Convert error to detailed JSON for logging
   * @returns {Object} Detailed error object (includes metadata)
   */
  toLogJSON() {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      isOperational: this.isOperational,
      metadata: this.metadata,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

// Specific error types for common scenarios

class ValidationError extends AppError {
  constructor(message, metadata = {}) {
    super(message, 400, 'VALIDATION_ERROR', true, metadata);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed', metadata = {}) {
    super(message, 401, 'AUTHENTICATION_ERROR', true, metadata);
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Access denied', metadata = {}) {
    super(message, 403, 'AUTHORIZATION_ERROR', true, metadata);
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource', metadata = {}) {
    super(`${resource} not found`, 404, 'NOT_FOUND', true, metadata);
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please try again later', metadata = {}) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', true, metadata);
  }
}

class ExternalServiceError extends AppError {
  constructor(service, message, metadata = {}) {
    super(`${service} error: ${message}`, 503, 'EXTERNAL_SERVICE_ERROR', true, {
      service,
      ...metadata
    });
  }
}

class DatabaseError extends AppError {
  constructor(message, metadata = {}) {
    super(message, 500, 'DATABASE_ERROR', true, metadata);
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ExternalServiceError,
  DatabaseError
};
