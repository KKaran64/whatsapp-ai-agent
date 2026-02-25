const logger = require('../logger');
const {
  hashPhoneNumber, redactSensitiveData,
  error, warn, info, debug, log,
  child, logRequest, logWhatsAppMessage,
  logAIProviderUsage, logDatabaseOperation, logSecurityEvent
} = logger;

// ─── hashPhoneNumber ─────────────────────────────────────────────────────────

describe('hashPhoneNumber', () => {
  test('hashes phone number preserving last 4 digits', () => {
    const result = hashPhoneNumber('919876543210');
    expect(result).toMatch(/^\*\*\*3210\([a-f0-9]{8}\)$/);
  });

  test('produces consistent hashes for same input', () => {
    const hash1 = hashPhoneNumber('919876543210');
    const hash2 = hashPhoneNumber('919876543210');
    expect(hash1).toBe(hash2);
  });

  test('produces different hashes for different numbers', () => {
    const hash1 = hashPhoneNumber('919876543210');
    const hash2 = hashPhoneNumber('919876543211');
    expect(hash1).not.toBe(hash2);
  });

  test('returns [UNKNOWN] for null/undefined', () => {
    expect(hashPhoneNumber(null)).toBe('[UNKNOWN]');
    expect(hashPhoneNumber(undefined)).toBe('[UNKNOWN]');
    expect(hashPhoneNumber('')).toBe('[UNKNOWN]');
  });

  test('handles short phone numbers', () => {
    const result = hashPhoneNumber('1234');
    expect(result).toMatch(/^\*\*\*1234\([a-f0-9]{8}\)$/);
  });
});

// ─── redactSensitiveData ─────────────────────────────────────────────────────

describe('redactSensitiveData', () => {
  test('redacts phone-related fields with hashed values', () => {
    const data = { phoneNumber: '919876543210', from: '919876543210' };
    const result = redactSensitiveData(data);
    expect(result.phoneNumber).toMatch(/^\*\*\*3210/);
    expect(result.from).toMatch(/^\*\*\*3210/);
  });

  test('redacts sensitive non-phone fields with [REDACTED]', () => {
    const data = {
      email: 'user@test.com',
      password: 'secret123',
      apiKey: 'key-123',
      secret: 'top-secret',
      creditCard: '4111111111111111',
      ssn: '123-45-6789'
    };
    const result = redactSensitiveData(data);

    expect(result.email).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.creditCard).toBe('[REDACTED]');
    expect(result.ssn).toBe('[REDACTED]');
  });

  test('redacts token/authorization/name fields with [REDACTED]', () => {
    const data = { token: 'abc-token', authorization: 'Bearer xyz', name: 'John' };
    const result = redactSensitiveData(data);
    expect(result.token).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.name).toBe('[REDACTED]');
  });

  test('hashes exact phone-like fields (from, to, phone, phoneNumber)', () => {
    const data = { from: '919876543210', to: '919876543211', phone: '9876543210' };
    const result = redactSensitiveData(data);
    expect(result.from).toMatch(/^\*\*\*/);
    expect(result.to).toMatch(/^\*\*\*/);
    expect(result.phone).toMatch(/^\*\*\*/);
  });

  test('preserves non-sensitive fields', () => {
    const data = { message: 'hello', provider: 'groq', statusCode: 200 };
    const result = redactSensitiveData(data);
    expect(result).toEqual(data);
  });

  test('redacts nested objects recursively', () => {
    const data = {
      user: {
        phoneNumber: '919876543210',
        email: 'test@test.com'
      }
    };
    const result = redactSensitiveData(data);
    expect(result.user.phoneNumber).toMatch(/^\*\*\*/);
    expect(result.user.email).toBe('[REDACTED]');
  });

  test('handles arrays', () => {
    const data = [{ phoneNumber: '919876543210' }];
    const result = redactSensitiveData(data);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].phoneNumber).toMatch(/^\*\*\*/);
  });

  test('returns primitive values unchanged', () => {
    expect(redactSensitiveData(null)).toBeNull();
    expect(redactSensitiveData(undefined)).toBeUndefined();
    expect(redactSensitiveData('string')).toBe('string');
    expect(redactSensitiveData(42)).toBe(42);
  });

  test('does not mutate the original object', () => {
    const original = { phoneNumber: '919876543210', message: 'test' };
    const originalCopy = { ...original };
    redactSensitiveData(original);
    expect(original).toEqual(originalCopy);
  });
});

// ─── Log Methods (formatLog, info, warn, error, debug, log) ─────────────────

describe('Logger - Log Methods', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {})
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('info() outputs valid JSON with timestamp and level', () => {
    info('Test message', { key: 'value' });
    expect(consoleSpy.log).toHaveBeenCalledTimes(1);

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.timestamp).toBeDefined();
    expect(output.level).toBe('INFO');
    expect(output.message).toBe('Test message');
    expect(output.key).toBe('value');
  });

  test('warn() outputs to console.warn with WARN level', () => {
    warn('Warning message');
    expect(consoleSpy.warn).toHaveBeenCalledTimes(1);

    const output = JSON.parse(consoleSpy.warn.mock.calls[0][0]);
    expect(output.level).toBe('WARN');
    expect(output.message).toBe('Warning message');
  });

  test('error() outputs to console.error with ERROR level', () => {
    error('Error occurred');
    expect(consoleSpy.error).toHaveBeenCalledTimes(1);

    const output = JSON.parse(consoleSpy.error.mock.calls[0][0]);
    expect(output.level).toBe('ERROR');
    expect(output.message).toBe('Error occurred');
  });

  test('error() includes Error object details when provided', () => {
    const err = new Error('Something broke');
    error('Failure', err, { requestId: 'req-123' });

    const output = JSON.parse(consoleSpy.error.mock.calls[0][0]);
    expect(output.error.message).toBe('Something broke');
    // Note: "name" is in SENSITIVE_FIELDS, so error.name gets [REDACTED]
    expect(output.error.name).toBe('[REDACTED]');
    expect(output.error.stack).toBeDefined();
    expect(output.requestId).toBe('req-123');
  });

  test('error() ignores non-Error errorObj', () => {
    error('Failure', 'not an error object');

    const output = JSON.parse(consoleSpy.error.mock.calls[0][0]);
    expect(output.error).toBeUndefined();
  });

  test('log() dispatches to correct level', () => {
    log('info', 'info msg');
    log('warn', 'warn msg');
    log('error', 'error msg');

    expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
    expect(consoleSpy.error).toHaveBeenCalledTimes(1);
  });

  test('log() defaults to info for unknown level', () => {
    log('banana', 'unknown level');
    expect(consoleSpy.log).toHaveBeenCalledTimes(1);

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.level).toBe('INFO');
  });

  test('formatLog redacts sensitive data in context', () => {
    info('Test', { email: 'user@test.com', statusCode: 200 });

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.email).toBe('[REDACTED]');
    expect(output.statusCode).toBe(200);
  });

  test('formatLog includes requestId when present', () => {
    info('Test', { requestId: 'abc-123' });

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.requestId).toBe('abc-123');
  });
});

// ─── child() logger ─────────────────────────────────────────────────────────

describe('Logger - child', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {})
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('creates child logger with default context', () => {
    const childLogger = child({ service: 'whatsapp', requestId: 'req-1' });
    childLogger.info('Child log');

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.service).toBe('whatsapp');
    expect(output.requestId).toBe('req-1');
    expect(output.message).toBe('Child log');
  });

  test('child logger merges call context with defaults', () => {
    const childLogger = child({ service: 'whatsapp' });
    childLogger.info('Test', { extra: 'data' });

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.service).toBe('whatsapp');
    expect(output.extra).toBe('data');
  });

  test('child logger call context overrides defaults', () => {
    const childLogger = child({ requestId: 'default' });
    childLogger.info('Test', { requestId: 'override' });

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.requestId).toBe('override');
  });
});

// ─── Domain-specific loggers ────────────────────────────────────────────────

describe('Logger - Domain Loggers', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {})
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('logRequest logs HTTP request details', () => {
    const req = { method: 'POST', path: '/webhook', ip: '1.2.3.4', get: () => 'TestAgent' };
    const res = { statusCode: 200 };
    logRequest(req, res, 45);

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.message).toBe('HTTP Request');
    expect(output.method).toBe('POST');
    expect(output.path).toBe('/webhook');
    expect(output.statusCode).toBe(200);
    expect(output.duration).toBe('45ms');
  });

  test('logWhatsAppMessage hashes phone number', () => {
    logWhatsAppMessage('incoming', '919876543210', 'text', 'req-1');

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.message).toBe('WhatsApp Message');
    expect(output.direction).toBe('incoming');
    // phoneNumber is pre-hashed by logWhatsAppMessage, then redactSensitiveData
    // hashes it again (double-hash). The output is ***<last4-of-hash>(<hash-of-hash>)
    expect(output.phoneNumber).toMatch(/^\*\*\*/);
    expect(output.messageType).toBe('text');
  });

  test('logAIProviderUsage logs provider details', () => {
    logAIProviderUsage('groq', 'llama-3.3-70b', 150, 'req-1');

    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.message).toBe('AI Provider Usage');
    expect(output.provider).toBe('groq');
    expect(output.model).toBe('llama-3.3-70b');
    // Note: "tokens" contains "token" (a sensitive field), so it gets [REDACTED]
    // This is a known quirk — the field name matches the SENSITIVE_FIELDS substring check
    expect(output.tokens).toBe('[REDACTED]');
  });

  test('logSecurityEvent uses error level for critical severity', () => {
    logSecurityEvent('rate_limit', 'critical', { ip: '1.2.3.4' }, 'req-1');

    // Critical → error level → console.error
    const output = JSON.parse(consoleSpy.error.mock.calls[0][0]);
    expect(output.level).toBe('ERROR');
    expect(output.message).toContain('Security Event');
    expect(output.eventType).toBe('rate_limit');
    expect(output.severity).toBe('critical');
  });

  test('logSecurityEvent uses warn level for non-critical severity', () => {
    logSecurityEvent('suspicious_input', 'medium', { input: 'test' }, 'req-2');

    const output = JSON.parse(consoleSpy.warn.mock.calls[0][0]);
    expect(output.level).toBe('WARN');
    expect(output.eventType).toBe('suspicious_input');
  });
});
