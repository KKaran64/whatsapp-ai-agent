const {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ExternalServiceError,
  DatabaseError
} = require('../errors/AppError');

// ─── AppError (base class) ──────────────────────────────────────────────────

describe('AppError', () => {
  test('sets all properties correctly', () => {
    const error = new AppError('Something went wrong', 500, 'INTERNAL_ERROR', true, { req: '123' });

    expect(error.message).toBe('Something went wrong');
    expect(error.statusCode).toBe(500);
    expect(error.errorCode).toBe('INTERNAL_ERROR');
    expect(error.isOperational).toBe(true);
    expect(error.metadata).toEqual({ req: '123' });
    expect(error.timestamp).toBeDefined();
    expect(error.name).toBe('AppError');
  });

  test('uses defaults for optional parameters', () => {
    const error = new AppError('test');
    expect(error.statusCode).toBe(500);
    expect(error.errorCode).toBe('INTERNAL_ERROR');
    expect(error.isOperational).toBe(true);
    expect(error.metadata).toEqual({});
  });

  test('extends Error', () => {
    const error = new AppError('test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  test('has stack trace', () => {
    const error = new AppError('test');
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('AppError');
  });

  test('toJSON returns safe client-facing object', () => {
    const error = new AppError('User-facing message', 400, 'BAD_INPUT', true, { secret: 'data' });
    const json = error.toJSON();

    expect(json).toEqual({
      error: 'User-facing message',
      code: 'BAD_INPUT',
      timestamp: expect.any(String)
    });
    // Must NOT expose internal metadata
    expect(json.metadata).toBeUndefined();
    expect(json.stack).toBeUndefined();
    expect(json.statusCode).toBeUndefined();
  });

  test('toLogJSON returns detailed object for logging', () => {
    const error = new AppError('Detailed error', 500, 'INTERNAL', false, { debug: true });
    const logJson = error.toLogJSON();

    expect(logJson).toEqual({
      name: 'AppError',
      message: 'Detailed error',
      statusCode: 500,
      errorCode: 'INTERNAL',
      isOperational: false,
      metadata: { debug: true },
      timestamp: expect.any(String),
      stack: expect.any(String)
    });
  });
});

// ─── ValidationError ─────────────────────────────────────────────────────────

describe('ValidationError', () => {
  test('sets correct defaults', () => {
    const error = new ValidationError('Invalid input');
    expect(error.statusCode).toBe(400);
    expect(error.errorCode).toBe('VALIDATION_ERROR');
    expect(error.isOperational).toBe(true);
    expect(error.name).toBe('ValidationError');
  });

  test('accepts metadata', () => {
    const error = new ValidationError('Bad field', { field: 'email' });
    expect(error.metadata).toEqual({ field: 'email' });
  });

  test('extends AppError', () => {
    expect(new ValidationError('test')).toBeInstanceOf(AppError);
  });
});

// ─── AuthenticationError ─────────────────────────────────────────────────────

describe('AuthenticationError', () => {
  test('sets correct defaults', () => {
    const error = new AuthenticationError();
    expect(error.message).toBe('Authentication failed');
    expect(error.statusCode).toBe(401);
    expect(error.errorCode).toBe('AUTHENTICATION_ERROR');
    expect(error.isOperational).toBe(true);
  });

  test('accepts custom message', () => {
    const error = new AuthenticationError('Token expired');
    expect(error.message).toBe('Token expired');
  });
});

// ─── AuthorizationError ──────────────────────────────────────────────────────

describe('AuthorizationError', () => {
  test('sets correct defaults', () => {
    const error = new AuthorizationError();
    expect(error.message).toBe('Access denied');
    expect(error.statusCode).toBe(403);
    expect(error.errorCode).toBe('AUTHORIZATION_ERROR');
  });
});

// ─── NotFoundError ───────────────────────────────────────────────────────────

describe('NotFoundError', () => {
  test('formats message with resource name', () => {
    const error = new NotFoundError('Customer');
    expect(error.message).toBe('Customer not found');
    expect(error.statusCode).toBe(404);
    expect(error.errorCode).toBe('NOT_FOUND');
  });

  test('uses default resource name', () => {
    const error = new NotFoundError();
    expect(error.message).toBe('Resource not found');
  });
});

// ─── RateLimitError ──────────────────────────────────────────────────────────

describe('RateLimitError', () => {
  test('sets correct defaults', () => {
    const error = new RateLimitError();
    expect(error.message).toBe('Too many requests, please try again later');
    expect(error.statusCode).toBe(429);
    expect(error.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });
});

// ─── ExternalServiceError ────────────────────────────────────────────────────

describe('ExternalServiceError', () => {
  test('formats message with service name', () => {
    const error = new ExternalServiceError('WhatsApp', 'Connection timeout');
    expect(error.message).toBe('WhatsApp error: Connection timeout');
    expect(error.statusCode).toBe(503);
    expect(error.errorCode).toBe('EXTERNAL_SERVICE_ERROR');
    expect(error.metadata.service).toBe('WhatsApp');
  });

  test('merges metadata with service info', () => {
    const error = new ExternalServiceError('Groq', 'Rate limited', { retryAfter: 60 });
    expect(error.metadata).toEqual({ service: 'Groq', retryAfter: 60 });
  });
});

// ─── DatabaseError ───────────────────────────────────────────────────────────

describe('DatabaseError', () => {
  test('sets correct defaults', () => {
    const error = new DatabaseError('Connection pool exhausted');
    expect(error.statusCode).toBe(500);
    expect(error.errorCode).toBe('DATABASE_ERROR');
    expect(error.isOperational).toBe(true);
  });

  test('includes operation metadata', () => {
    const error = new DatabaseError('Write failed', { operation: 'insert', collection: 'customers' });
    expect(error.metadata.operation).toBe('insert');
    expect(error.metadata.collection).toBe('customers');
  });
});
