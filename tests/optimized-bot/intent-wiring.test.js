process.env.MONGODB_ENCRYPTION_KEY = process.env.MONGODB_ENCRYPTION_KEY || 'a'.repeat(64);

jest.mock('../../optimized-bot/router-agent');
jest.mock('../../optimized-bot/responder-agent');
jest.mock('../../optimized-bot/state-manager');
jest.mock('../../optimized-bot/media-handler');
jest.mock('../../pricing/intent-resolver');

const RouterAgent = require('../../optimized-bot/router-agent');
const ResponderAgent = require('../../optimized-bot/responder-agent');
const StateManager = require('../../optimized-bot/state-manager');
const { resolveIntent } = require('../../pricing/intent-resolver');

describe('optimized-bot wires resolveIntent and stores pricing_customer_type', () => {
  let bot;

  beforeEach(() => {
    jest.clearAllMocks();
    StateManager.getState = jest.fn().mockResolvedValue({ current_node: 'QUOTE_REQUEST', product_interest: ['coasters'], qualifiers: {} });
    StateManager.transitionNode = jest.fn().mockResolvedValue();
    StateManager.getRecentMessages = jest.fn().mockResolvedValue([]);
    StateManager.addMessage = jest.fn().mockResolvedValue();
    StateManager.updateState = jest.fn().mockResolvedValue();
    StateManager.updateQualifiers = jest.fn().mockResolvedValue();
    StateManager.addProductInterest = jest.fn().mockResolvedValue();
    StateManager.wasImageSent = jest.fn().mockResolvedValue(false);

    RouterAgent.mockImplementation(() => ({
      classify: jest.fn().mockResolvedValue('QUOTE_REQUEST'),
      getStats: jest.fn().mockReturnValue({})
    }));
    ResponderAgent.mockImplementation(() => ({
      generateResponse: jest.fn().mockResolvedValue({ response: 'How many pieces?', media: null }),
      getStats: jest.fn().mockReturnValue({})
    }));

    resolveIntent.mockResolvedValue({
      productQuery: 'square coaster',
      quantity: 100,
      customerType: 'reseller',
      refinements: [],
      confidence: 0.9,
      source: 'llm'
    });

    const { createInstance } = require('../../optimized-bot/index');
    bot = createInstance({ GROQ_API_KEY: 'test-key' });
  });

  test('calls resolveIntent with the sanitized message and recent context', async () => {
    await bot.processMessage('919876543210', '100 square coasters for resale', 'text');
    expect(resolveIntent).toHaveBeenCalledTimes(1);
    const [msgArg, contextArg] = resolveIntent.mock.calls[0];
    expect(msgArg).toContain('coaster');
    expect(Array.isArray(contextArg)).toBe(true);
  });

  test('stores intent.customerType as pricing_customer_type, not product_type', async () => {
    await bot.processMessage('919876543210', '100 square coasters for resale', 'text');
    const updateCall = StateManager.updateState.mock.calls.find(
      call => call[1] && Object.prototype.hasOwnProperty.call(call[1], 'pricing_customer_type')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1].pricing_customer_type).toBe('reseller');
    // product_type must be untouched by this — different axis, different field.
    const productTypeCall = StateManager.updateState.mock.calls.find(
      call => call[1] && Object.prototype.hasOwnProperty.call(call[1], 'product_type')
    );
    if (productTypeCall) {
      expect(productTypeCall[1].product_type).not.toBe('reseller');
    }
  });

  test('does not throw when resolveIntent rejects (non-fatal, matches existing fallback-first design)', async () => {
    resolveIntent.mockRejectedValue(new Error('Groq timeout'));
    const result = await bot.processMessage('919876543210', '100 square coasters', 'text');
    expect(result.response).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test('pricing_customer_type accepts only the pricing-slab enum, never a product_type value', () => {
    const OptimizedState = require('../../models/OptimizedState');
    const good = new OptimizedState({ customer_phone: '919999999996', pricing_customer_type: 'reseller' });
    expect(good.validateSync()).toBeUndefined();

    // 'corporate' is a product_type (use-case) value — it must not be a
    // valid pricing slab, or the two axes could silently be conflated.
    const bad = new OptimizedState({ customer_phone: '919999999995', pricing_customer_type: 'corporate' });
    expect(bad.validateSync()).toBeDefined();
  });
});
