/**
 * Regression test for item 2 (final-fix-render brief):
 * server.js used to hand AIProviderManager (and the optimized-bot's
 * RouterAgent/ResponderAgent) a config built from CONFIG.GROQ_API_KEY.._4
 * and CONFIG.GEMINI_API_KEY.._10 only, even though collectGroqKeys() reads
 * up to GROQ_API_KEY_10 and AIProviderManager's own Gemini loop reads up to
 * GEMINI_API_KEY_20 — keys beyond those hard-coded ranges were silently
 * dropped no matter how many Render actually had configured.
 *
 * This is a separate file (own module registry) rather than an addition to
 * tests/server.test.js because that file's single shared `require('../server')`
 * in beforeAll is reused by ~470 other tests — changing its env vars here
 * would risk disturbing all of them. Mock setup mirrors server.test.js's
 * pattern exactly (same mocks, same order) since that is the known-working
 * way to require server.js without triggering real DB/queue/HTTP side effects.
 */

// ─── Environment variables (must be set BEFORE require) ────────────────────
process.env.WHATSAPP_TOKEN = 'test-whatsapp-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
process.env.VERIFY_TOKEN = 'test-verify-token';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.WHATSAPP_APP_SECRET = '';
process.env.NODE_ENV = 'development';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GROQ_API_KEY_7 = 'k7';       // beyond the old hard-coded GROQ_API_KEY_2.._4 range
process.env.GEMINI_API_KEY = '';
process.env.GEMINI_API_KEY_15 = 'g15';   // beyond the old hard-coded GEMINI_API_KEY_2.._10 range
process.env.PORT = '0';

// ─── Mock mongoose ─────────────────────────────────────────────────────────
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connect: jest.fn().mockResolvedValue(),
    connection: { readyState: 1, on: jest.fn(), close: jest.fn().mockResolvedValue() },
    Schema: actual.Schema,
    model: jest.fn().mockReturnValue(function MockModel() {})
  };
});

// ─── Mock Bull (Redis queue) ───────────────────────────────────────────────
jest.mock('bull', () => {
  return jest.fn().mockImplementation(() => ({
    process: jest.fn(),
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    on: jest.fn(),
    isReady: jest.fn().mockResolvedValue(true),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 5 }),
    close: jest.fn().mockResolvedValue()
  }));
});

// ─── Mock Sentry ───────────────────────────────────────────────────────────
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  Handlers: {
    requestHandler: jest.fn(() => (req, res, next) => next()),
    tracingHandler: jest.fn(() => (req, res, next) => next()),
    errorHandler: jest.fn(() => (err, req, res, next) => next(err))
  }
}));

// ─── Mock dotenv ───────────────────────────────────────────────────────────
jest.mock('dotenv', () => ({ config: jest.fn() }));

// ─── Mock Mongoose models ──────────────────────────────────────────────────
jest.mock('../models/Customer', () => ({
  findOne: jest.fn(),
  countDocuments: jest.fn().mockResolvedValue(0),
  find: jest.fn(),
  phoneFilter: (phone) => ({ phoneHash: `hash:${phone}` })
}));

jest.mock('../models/Conversation', () => ({
  findOne: jest.fn(),
  countDocuments: jest.fn().mockResolvedValue(0),
  updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  phoneFilter: (phone) => ({ phoneHash: `hash:${phone}` })
}));

jest.mock('../models/Product', () => ({
  find: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  countDocuments: jest.fn().mockResolvedValue(0),
  deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  insertMany: jest.fn().mockResolvedValue(),
  aggregate: jest.fn().mockResolvedValue([])
}));

// ─── Mock AI Provider Manager — the thing under test ───────────────────────
const mockAiManager = {
  groqClients: [{ id: 1 }],
  geminiKeys: [],
  getResponse: jest.fn().mockResolvedValue({ response: 'Hello from AI!', provider: 'groq' })
};
const mockAIProviderManagerCtor = jest.fn().mockImplementation(() => mockAiManager);
jest.mock('../ai-provider-manager', () => mockAIProviderManagerCtor);

// ─── Mock Vision Handler ───────────────────────────────────────────────────
jest.mock('../vision-handler', () => {
  return jest.fn().mockImplementation(() => ({
    handleImageMessage: jest.fn().mockResolvedValue({ response: 'ok', confidence: 0.85 }),
    getStats: jest.fn().mockReturnValue({ totalRequests: 0, successRate: '0%' }),
    shutdown: jest.fn()
  }));
});

// ─── Mock whatsapp-media-upload ────────────────────────────────────────────
jest.mock('../whatsapp-media-upload', () => ({
  uploadAndSendImage: jest.fn().mockResolvedValue({ success: true, response: {} }),
  getCacheStats: jest.fn().mockReturnValue({ hits: 0, misses: 0 })
}));

// ─── Mock product-images-v2 ────────────────────────────────────────────────
jest.mock('../product-images-v2', () => ({
  findProductImage: jest.fn().mockReturnValue(null),
  getCatalogImages: jest.fn().mockReturnValue([]),
  isValidCorkProductUrl: jest.fn().mockReturnValue(false),
  getDatabaseStats: jest.fn().mockReturnValue({ total: 0 })
}));

// ─── Mock axios ────────────────────────────────────────────────────────────
jest.mock('axios', () => ({
  post: jest.fn().mockResolvedValue({ data: { messages: [{ id: 'msg-1' }] } }),
  get: jest.fn().mockResolvedValue({ data: {} })
}));

// ─── Mock express-rate-limit / helmet (pass-through) ───────────────────────
jest.mock('express-rate-limit', () => jest.fn().mockImplementation(() => (req, res, next) => next()));
jest.mock('helmet', () => jest.fn().mockImplementation(() => (req, res, next) => next()));

// ─── Mock input-sanitizer ──────────────────────────────────────────────────
jest.mock('../input-sanitizer', () => ({
  sanitizeMongoInput: jest.fn(v => v),
  sanitizePhoneNumber: jest.fn(v => v),
  sanitizeMessageContent: jest.fn(v => v),
  sanitizeAIPrompt: jest.fn(v => v),
  detectSuspiciousInput: jest.fn(() => false)
}));

// ─── Mock error handling modules ───────────────────────────────────────────
jest.mock('../errors/AppError', () => ({
  AppError: class AppError extends Error { constructor(msg) { super(msg); } },
  ValidationError: class ValidationError extends Error {},
  ExternalServiceError: class ExternalServiceError extends Error {}
}));

jest.mock('../middleware/errorHandler', () => ({
  errorHandler: (err, req, res, next) => res.status(500).json({ error: err.message }),
  notFoundHandler: (req, res) => res.status(404).json({ error: 'Not found' }),
  handleUnhandledRejection: jest.fn(),
  handleUncaughtException: jest.fn()
}));

jest.mock('../middleware/requestId', () => ({
  requestIdMiddleware: (req, res, next) => { req.requestId = 'test-req-id'; next(); },
  generateRequestId: jest.fn().mockReturnValue('abc123def456')
}));

// ─── Mock utils/database ──────────────────────────────────────────────────
jest.mock('../utils/database', () => ({
  updateConversationHistory: jest.fn().mockResolvedValue(),
  updateLeadQualification: jest.fn().mockResolvedValue(),
  getConversationHistory: jest.fn().mockResolvedValue([]),
  getOrCreateCustomer: jest.fn().mockResolvedValue({ phoneNumber: '1234567890' }),
  updateCustomerMetadata: jest.fn().mockResolvedValue()
}));

// ─── Mock scripts/products-data.json for admin import ──────────────────────
jest.mock('../scripts/products-data.json', () => [], { virtual: true });

// ─── Mock scripts/probe-models (prevents real network calls) ──────────────
jest.mock('../scripts/probe-models', () => ({
  probeModels: jest.fn().mockResolvedValue({ ok: true, missing: [], checked: [], errors: [], checkedAt: new Date().toISOString() })
}));

// ─── Prevent process.exit from killing tests ───────────────────────────────
const originalExit = process.exit;
process.exit = jest.fn();

afterAll(() => {
  process.exit = originalExit;
});

describe('server.js CONFIG wiring — full Groq/Gemini key ranges reach AIProviderManager', () => {
  test('constructor config carries GROQ_API_KEY_7 and GEMINI_API_KEY_15, not just keys 1-4/1-10', () => {
    require('../server');

    expect(mockAIProviderManagerCtor).toHaveBeenCalledTimes(1);
    const config = mockAIProviderManagerCtor.mock.calls[0][0];
    expect(config.GROQ_API_KEY_7).toBe('k7');
    expect(config.GEMINI_API_KEY_15).toBe('g15');
  });
});
