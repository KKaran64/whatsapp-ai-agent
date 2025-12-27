/**
 * Structured Logger
 *
 * Provides JSON-formatted logging with levels, timestamps, and context
 * For production environments with log aggregation (DataDog, CloudWatch, etc.)
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const currentLevelValue = LOG_LEVELS[CURRENT_LOG_LEVEL] || LOG_LEVELS.info;

/**
 * Format log entry as JSON
 */
function formatLog(level, message, context = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...context
  };

  // Add environment info
  if (process.env.NODE_ENV) {
    logEntry.environment = process.env.NODE_ENV;
  }

  // Add request ID if available
  if (context.requestId) {
    logEntry.requestId = context.requestId;
  }

  return JSON.stringify(logEntry);
}

/**
 * Log error with stack trace
 */
function error(message, errorObj = null, context = {}) {
  if (LOG_LEVELS.error > currentLevelValue) return;

  const logContext = { ...context };

  if (errorObj instanceof Error) {
    logContext.error = {
      message: errorObj.message,
      stack: errorObj.stack,
      name: errorObj.name
    };
  }

  console.error(formatLog('error', message, logContext));
}

/**
 * Log warning
 */
function warn(message, context = {}) {
  if (LOG_LEVELS.warn > currentLevelValue) return;
  console.warn(formatLog('warn', message, context));
}

/**
 * Log informational message
 */
function info(message, context = {}) {
  if (LOG_LEVELS.info > currentLevelValue) return;
  console.log(formatLog('info', message, context));
}

/**
 * Log debug message (only in development)
 */
function debug(message, context = {}) {
  if (LOG_LEVELS.debug > currentLevelValue) return;
  console.log(formatLog('debug', message, context));
}

/**
 * Log with custom level
 */
function log(level, message, context = {}) {
  switch (level) {
    case 'error':
      error(message, null, context);
      break;
    case 'warn':
      warn(message, context);
      break;
    case 'info':
      info(message, context);
      break;
    case 'debug':
      debug(message, context);
      break;
    default:
      info(message, context);
  }
}

/**
 * Create child logger with default context
 */
function child(defaultContext = {}) {
  return {
    error: (msg, err, ctx) => error(msg, err, { ...defaultContext, ...ctx }),
    warn: (msg, ctx) => warn(msg, { ...defaultContext, ...ctx }),
    info: (msg, ctx) => info(msg, { ...defaultContext, ...ctx }),
    debug: (msg, ctx) => debug(msg, { ...defaultContext, ...ctx }),
    log: (lvl, msg, ctx) => log(lvl, msg, { ...defaultContext, ...ctx })
  };
}

/**
 * Log HTTP request
 */
function logRequest(req, res, duration) {
  info('HTTP Request', {
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    duration: `${duration}ms`,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
}

/**
 * Log WhatsApp message
 */
function logWhatsAppMessage(direction, phoneNumber, messageType, requestId) {
  info('WhatsApp Message', {
    direction, // 'incoming' or 'outgoing'
    phoneNumber,
    messageType,
    requestId
  });
}

/**
 * Log AI provider usage
 */
function logAIProviderUsage(provider, model, tokens, requestId) {
  info('AI Provider Usage', {
    provider, // 'groq', 'gemini', 'claude'
    model,
    tokens,
    requestId
  });
}

/**
 * Log database operation
 */
function logDatabaseOperation(operation, collection, duration, requestId) {
  debug('Database Operation', {
    operation, // 'find', 'insert', 'update', 'delete'
    collection,
    duration: `${duration}ms`,
    requestId
  });
}

/**
 * Log security event
 */
function logSecurityEvent(eventType, severity, details, requestId) {
  const level = severity === 'critical' ? 'error' : 'warn';
  log(level, `Security Event: ${eventType}`, {
    eventType,
    severity,
    ...details,
    requestId
  });
}

module.exports = {
  error,
  warn,
  info,
  debug,
  log,
  child,
  logRequest,
  logWhatsAppMessage,
  logAIProviderUsage,
  logDatabaseOperation,
  logSecurityEvent
};
