// Request ID Middleware
// Assigns unique ID to each request for tracking

const crypto = require('crypto');

/**
 * Generate unique request ID
 * @returns {string} 12-character hex string
 */
function generateRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Middleware to attach request ID to every request
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
function requestIdMiddleware(req, res, next) {
  // Use existing request ID from header or generate new one
  req.requestId = req.headers['x-request-id'] || generateRequestId();

  // Add to response headers for tracking
  res.setHeader('X-Request-ID', req.requestId);

  next();
}

module.exports = {
  requestIdMiddleware,
  generateRequestId
};
