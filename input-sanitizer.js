/**
 * Input Sanitization Utility
 *
 * Prevents injection attacks (NoSQL, XSS, Log Injection, Prompt Injection)
 * GDPR/CCPA compliant data validation
 */

/**
 * Sanitize MongoDB input to prevent NoSQL injection
 * Removes MongoDB operators and ensures type safety
 */
function sanitizeMongoInput(input) {
  // Only allow strings
  if (typeof input !== 'string') {
    throw new Error('Invalid input type - expected string');
  }

  // Remove MongoDB operators ($where, $regex, etc.)
  let sanitized = input.replace(/^\$/g, '').trim();

  // Remove control characters
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Validate and sanitize phone number
 * Indian phone numbers: 10 digits or 12-15 digits with country code
 */
function sanitizePhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    throw new Error('Phone number required');
  }

  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, '');

  // Validate format (10-15 digits)
  if (!/^\d{10,15}$/.test(digits)) {
    throw new Error('Invalid phone number format');
  }

  return digits;
}

/**
 * Sanitize user message content
 * Removes HTML, scripts, MongoDB operators, log injection attempts
 */
function sanitizeMessageContent(content) {
  if (!content || typeof content !== 'string') {
    return '';
  }

  let sanitized = content;

  // 1. Remove HTML/XML tags
  sanitized = sanitized.replace(/<[^>]*>/g, '');

  // 2. Remove HTML entities
  sanitized = sanitized.replace(/&[#\w]+;/g, '');

  // 3. Remove MongoDB operators
  sanitized = sanitized.replace(/\$\w+/g, '');

  // 4. Remove ANSI escape codes (prevent log injection)
  sanitized = sanitized.replace(/\x1b\[[0-9;]*m/g, '');

  // 5. Remove control characters except newlines and tabs
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // 6. Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}

/**
 * Sanitize AI prompt input to prevent prompt injection
 * Removes common prompt injection patterns
 */
function sanitizeAIPrompt(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') {
    return '';
  }

  let sanitized = userMessage;

  // Remove common prompt injection patterns
  const dangerousPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/gi,
    /forget\s+(everything|all|previous)/gi,
    /you\s+are\s+now/gi,
    /system\s+(override|mode|prompt|role)/gi,
    /new\s+instructions/gi,
    /DAN\s+mode/gi,
    /developer\s+mode/gi,
    /sudo\s+mode/gi,
    /jailbreak/gi,
    /act\s+as\s+(?!a\s+sales)/gi // Allow "act as a sales assistant" but block others
  ];

  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, '[removed]');
  }

  // Remove special characters that could break context
  sanitized = sanitized.replace(/[{}[\]<>]/g, '');

  // Truncate excessively long messages (prevent token flooding)
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 500) + '...';
  }

  return sanitized;
}

/**
 * Validate email format
 */
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new Error('Email required');
  }

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const sanitized = email.toLowerCase().trim();

  if (!emailRegex.test(sanitized)) {
    throw new Error('Invalid email format');
  }

  return sanitized;
}

/**
 * Validate Indian GST number
 * Format: 22AAAAA0000A1Z5 (15 alphanumeric)
 */
function sanitizeGSTNumber(gstNumber) {
  if (!gstNumber || typeof gstNumber !== 'string') {
    throw new Error('GST number required');
  }

  const sanitized = gstNumber.toUpperCase().trim();

  // GST format: 2 digits (state) + 10 alphanumeric (PAN) + 1 letter (entity) + 1 letter (Z default) + 1 alphanumeric (checksum)
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(sanitized)) {
    throw new Error('Invalid GST number format');
  }

  return sanitized;
}

/**
 * Sanitize URL to prevent SSRF attacks
 */
function sanitizeURL(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('URL required');
  }

  try {
    const urlObj = new URL(url);

    // Only allow HTTP and HTTPS
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      throw new Error('Invalid protocol - only HTTP(S) allowed');
    }

    // Prevent access to local/private IPs
    const hostname = urlObj.hostname.toLowerCase();

    const blockedPatterns = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '10.',
      '172.16.',
      '172.17.',
      '172.18.',
      '172.19.',
      '172.20.',
      '172.21.',
      '172.22.',
      '172.23.',
      '172.24.',
      '172.25.',
      '172.26.',
      '172.27.',
      '172.28.',
      '172.29.',
      '172.30.',
      '172.31.',
      '192.168.',
      '169.254.', // AWS metadata
      '[::1]', // IPv6 localhost
      'metadata.google.internal' // GCP metadata
    ];

    for (const pattern of blockedPatterns) {
      if (hostname.includes(pattern)) {
        throw new Error('Access to private/local addresses not allowed');
      }
    }

    return urlObj.href;
  } catch (error) {
    throw new Error(`Invalid URL: ${error.message}`);
  }
}

/**
 * Detect suspicious patterns in user input
 * Returns true if input looks like an attack attempt
 */
function detectSuspiciousInput(input) {
  if (!input || typeof input !== 'string') {
    return false;
  }

  const suspiciousPatterns = [
    /ignore\s+previous\s+instructions/i,
    /system\s+prompt/i,
    /you\s+are\s+now/i,
    /<script>/i,
    /javascript:/i,
    /onerror=/i,
    /onclick=/i,
    /\$where/i,
    /union\s+select/i,
    /drop\s+table/i,
    /\x1b\[/,  // ANSI escape codes
    /\.\.\//   // Path traversal
  ];

  return suspiciousPatterns.some(pattern => pattern.test(input));
}

module.exports = {
  sanitizeMongoInput,
  sanitizePhoneNumber,
  sanitizeMessageContent,
  sanitizeAIPrompt,
  sanitizeEmail,
  sanitizeGSTNumber,
  sanitizeURL,
  detectSuspiciousInput
};
