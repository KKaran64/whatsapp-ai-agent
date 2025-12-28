// Global Error Handler Middleware
// Catches all errors and sends appropriate responses

const Sentry = require('@sentry/node');
const { AppError } = require('../errors/AppError');

/**
 * Generate unique request ID for error tracking
 * @returns {string} 12-character hex string
 */
function generateRequestId() {
  return require('crypto').randomBytes(6).toString('hex');
}

/**
 * Global error handling middleware
 * @param {Error} err - Error object
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
function errorHandler(err, req, res, next) {
  // Generate unique request ID for tracking
  const requestId = req.requestId || generateRequestId();

  // Determine if this is an operational error or programming error
  const isOperational = err instanceof AppError && err.isOperational;

  // Default to 500 if not set
  const statusCode = err.statusCode || 500;
  const errorCode = err.errorCode || 'INTERNAL_ERROR';

  // Log error with full details
  console.error(`❌ [${requestId}] Error:`, {
    name: err.name,
    message: err.message,
    code: errorCode,
    statusCode,
    isOperational,
    stack: err.stack,
    metadata: err.metadata || {},
    url: req.originalUrl,
    method: req.method,
    ip: req.ip
  });

  // Send to Sentry if configured (for non-operational errors or high severity)
  if (process.env.SENTRY_DSN && (!isOperational || statusCode >= 500)) {
    Sentry.captureException(err, {
      tags: {
        requestId,
        errorCode,
        isOperational: isOperational.toString()
      },
      extra: {
        url: req.originalUrl,
        method: req.method,
        body: sanitizeRequestBody(req.body),
        metadata: err.metadata || {}
      }
    });
  }

  // Prepare response
  const response = {
    error: isOperational ? err.message : 'Internal server error',
    code: errorCode,
    requestId,
    timestamp: new Date().toISOString()
  };

  // Add stack trace only in development
  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
    response.metadata = err.metadata;
  }

  // Send response
  res.status(statusCode).json(response);
}

/**
 * Sanitize request body for logging (remove sensitive data)
 * @param {Object} body - Request body
 * @returns {Object} Sanitized body
 */
function sanitizeRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const sanitized = { ...body };

  // Remove sensitive fields
  const sensitiveFields = [
    'password',
    'token',
    'secret',
    'apiKey',
    'api_key',
    'authorization',
    'credit_card',
    'ssn'
  ];

  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });

  return sanitized;
}

/**
 * Handle unhandled promise rejections
 */
function handleUnhandledRejection() {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(reason, {
        tags: {
          type: 'unhandledRejection'
        }
      });
    }

    // In production, exit gracefully
    if (process.env.NODE_ENV === 'production') {
      console.error('💀 Exiting due to unhandled rejection');
      process.exit(1);
    }
  });
}

/**
 * Handle uncaught exceptions
 */
function handleUncaughtException() {
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error, {
        tags: {
          type: 'uncaughtException'
        }
      });
    }

    // Always exit on uncaught exception (unsafe to continue)
    console.error('💀 Exiting due to uncaught exception');
    process.exit(1);
  });
}

/**
 * 404 Not Found handler
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 */
function notFoundHandler(req, res) {
  const requestId = req.requestId || generateRequestId();

  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    requestId,
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  errorHandler,
  notFoundHandler,
  handleUnhandledRejection,
  handleUncaughtException,
  generateRequestId
};
