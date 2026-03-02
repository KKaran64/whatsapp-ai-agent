const { AppError, ValidationError, DatabaseError } = require('../errors/AppError');

// Mock Sentry
jest.mock('@sentry/node', () => ({
  captureException: jest.fn()
}));
const Sentry = require('@sentry/node');

const {
  errorHandler,
  notFoundHandler,
  generateRequestId
} = require('../middleware/errorHandler');

// Suppress console output
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ─── Helper: mock Express req/res ────────────────────────────────────────────

function mockReq(overrides = {}) {
  return {
    originalUrl: '/webhook',
    method: 'POST',
    ip: '127.0.0.1',
    body: {},
    requestId: null,
    ...overrides
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ─── generateRequestId ──────────────────────────────────────────────────────

describe('generateRequestId', () => {
  test('returns 12-character hex string', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
  });
});

// ─── errorHandler ────────────────────────────────────────────────────────────

describe('errorHandler', () => {
  const next = jest.fn();

  test('returns operational error message to client', () => {
    const err = new ValidationError('Invalid email format');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Invalid email format',
        code: 'VALIDATION_ERROR',
        requestId: expect.any(String),
        timestamp: expect.any(String)
      })
    );
  });

  test('hides internal error details from client', () => {
    const err = new Error('MongoDB cursor timeout at offset 0x4F2A');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    const response = res.json.mock.calls[0][0];
    expect(response.error).toBe('Internal server error');
    expect(response.error).not.toContain('MongoDB');
  });

  test('uses error statusCode when available', () => {
    const err = new DatabaseError('Connection lost');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('defaults to 500 when no statusCode', () => {
    const err = new Error('Unknown');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('uses req.requestId when available', () => {
    const err = new Error('test');
    const req = mockReq({ requestId: 'abc123def456' });
    const res = mockRes();

    errorHandler(err, req, res, next);

    const response = res.json.mock.calls[0][0];
    expect(response.requestId).toBe('abc123def456');
  });

  test('includes stack trace in development mode', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const err = new AppError('Dev error', 400, 'DEV_ERROR');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);

    const response = res.json.mock.calls[0][0];
    expect(response.stack).toBeDefined();

    process.env.NODE_ENV = origEnv;
  });

  test('excludes stack trace in production mode', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const err = new AppError('Prod error', 400, 'PROD_ERROR');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);

    const response = res.json.mock.calls[0][0];
    expect(response.stack).toBeUndefined();

    process.env.NODE_ENV = origEnv;
  });

  test('sends to Sentry for 500+ errors when DSN configured', () => {
    const origDSN = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://fake@sentry.io/123';

    const err = new DatabaseError('Critical DB failure');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({
          errorCode: 'DATABASE_ERROR'
        })
      })
    );

    process.env.SENTRY_DSN = origDSN;
  });

  test('does NOT send operational < 500 errors to Sentry', () => {
    const origDSN = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://fake@sentry.io/123';
    Sentry.captureException.mockClear();

    const err = new ValidationError('Bad input');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, next);

    expect(Sentry.captureException).not.toHaveBeenCalled();

    process.env.SENTRY_DSN = origDSN;
  });

  test('sanitizes request body in Sentry context', () => {
    const origDSN = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://fake@sentry.io/123';
    Sentry.captureException.mockClear();

    const err = new Error('crash');
    const req = mockReq({ body: { message: 'hello', password: 'secret123', token: 'abc' } });
    const res = mockRes();

    errorHandler(err, req, res, next);

    const sentryCall = Sentry.captureException.mock.calls[0][1];
    expect(sentryCall.extra.body.password).toBe('[REDACTED]');
    expect(sentryCall.extra.body.token).toBe('[REDACTED]');
    expect(sentryCall.extra.body.message).toBe('hello');

    process.env.SENTRY_DSN = origDSN;
  });
});

// ─── notFoundHandler ─────────────────────────────────────────────────────────

describe('notFoundHandler', () => {
  test('returns 404 with endpoint info', () => {
    const req = mockReq({ originalUrl: '/api/unknown', method: 'GET' });
    const res = mockRes();

    notFoundHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Endpoint not found',
        code: 'NOT_FOUND',
        path: '/api/unknown',
        method: 'GET'
      })
    );
  });

  test('includes request ID', () => {
    const req = mockReq({ requestId: 'test-req-id' });
    const res = mockRes();

    notFoundHandler(req, res);

    const response = res.json.mock.calls[0][0];
    expect(response.requestId).toBe('test-req-id');
  });

  test('generates request ID when not present', () => {
    const req = mockReq();
    const res = mockRes();

    notFoundHandler(req, res);

    const response = res.json.mock.calls[0][0];
    expect(response.requestId).toMatch(/^[a-f0-9]{12}$/);
  });
});
