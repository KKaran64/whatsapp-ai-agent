process.env.MONGODB_ENCRYPTION_KEY = process.env.MONGODB_ENCRYPTION_KEY || 'a'.repeat(64);

jest.mock('../../optimized-bot/router-agent');
jest.mock('../../optimized-bot/responder-agent');
jest.mock('../../optimized-bot/state-manager');
jest.mock('../../optimized-bot/media-handler');
jest.mock('../../pricing/intent-resolver');
jest.mock('../../pricing/conversation-state');

const RouterAgent = require('../../optimized-bot/router-agent');
const ResponderAgent = require('../../optimized-bot/responder-agent');
const StateManager = require('../../optimized-bot/state-manager');
const { resolveIntent } = require('../../pricing/intent-resolver');
const { deriveStateAsync } = require('../../pricing/conversation-state');
const { computeQuote } = require('../../pricing/quote-engine');

// quote-engine is deliberately NOT mocked — these tests must exercise the
// real allowed-amount set. 'square coaster' resolves to exactly one catalog
// entry (₹15/pc, ₹1,575 total for 100 reseller); a broader query like
// 'coasters' matches 36 products and returns { found: false }, which would
// silently disable enforce()'s fabrication check and make these tests
// pass/fail for the wrong reason.
const QUOTE = computeQuote({ productQuery: 'square coaster', quantity: 100, customerType: 'reseller' });
const REAL_TOTAL = '1,575';
const FABRICATED = '9,999';

function stubStateManager() {
  StateManager.getState = jest.fn().mockResolvedValue({ current_node: 'QUOTE_REQUEST', product_interest: ['coasters'], qualifiers: {} });
  StateManager.transitionNode = jest.fn().mockResolvedValue();
  StateManager.getRecentMessages = jest.fn().mockResolvedValue([]);
  StateManager.addMessage = jest.fn().mockResolvedValue();
  StateManager.updateState = jest.fn().mockResolvedValue();
  StateManager.updateQualifiers = jest.fn().mockResolvedValue();
  StateManager.addProductInterest = jest.fn().mockResolvedValue();
  StateManager.wasImageSent = jest.fn().mockResolvedValue(false);
  StateManager.markImageSent = jest.fn().mockResolvedValue();
}

function botReplying(response, media = null) {
  ResponderAgent.mockImplementation(() => ({
    generateResponse: jest.fn().mockResolvedValue({ response, media }),
    getStats: jest.fn().mockReturnValue({})
  }));
  const { createInstance } = require('../../optimized-bot/index');
  return createInstance({ GROQ_API_KEY: 'test-key' });
}

describe('optimized-bot enforces the outbound reply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubStateManager();

    RouterAgent.mockImplementation(() => ({
      classify: jest.fn().mockResolvedValue('QUOTE_REQUEST'),
      getStats: jest.fn().mockReturnValue({})
    }));

    resolveIntent.mockResolvedValue({
      productQuery: 'square coaster', quantity: 100, customerType: 'reseller',
      refinements: [], confidence: 0.9, source: 'llm'
    });
    deriveStateAsync.mockResolvedValue({
      code: 'QUOTE_PRESENTED', canBotQuote: true, allowedActions: [], guard: '', reason: 'test'
    });
  });

  test('the quote fixture really resolved (guards every assertion below)', () => {
    expect(QUOTE.found).toBe(true);
    expect(QUOTE.grandTotal).toBe(1575);
  });

  test('blocks and repairs a fabricated ₹ amount the LLM invented', async () => {
    const bot = botReplying(`Sure! That will be ₹${FABRICATED} total.`);
    const result = await bot.processMessage('919876543210', '100 square coasters for resale, what is the price', 'text');

    expect(result.response).not.toContain(FABRICATED);
    expect(result.response).not.toContain('9999');
    // Repaired, not merely blanked — the real figure replaces the fake one.
    expect(result.response).toContain(REAL_TOTAL);
  });

  test('allows a reply that matches the verified quote through unchanged', async () => {
    const good = `Sure! Total for 100 pcs: ₹${REAL_TOTAL}.`;
    const bot = botReplying(good);
    const result = await bot.processMessage('919876543210', '100 square coasters for resale, what is the price', 'text');

    expect(result.response).toBe(good);
  });

  test('template short-circuit responses also pass through enforce (not just LLM responses)', async () => {
    // A response carrying a media trigger AND a fabricated price — the guard
    // must not treat media/template-sourced replies as exempt.
    const bot = botReplying(`Sure! That will be ₹${FABRICATED}.`, 'coasters');
    const result = await bot.processMessage('919876543210', 'show me square coasters', 'text');

    expect(result.response).not.toContain(FABRICATED);
  });

  test('does not throw when deriveStateAsync rejects (non-fatal)', async () => {
    deriveStateAsync.mockRejectedValue(new Error('Groq timeout'));
    const bot = botReplying('Hi!');
    const result = await bot.processMessage('919876543210', 'hello', 'text');

    expect(result.response).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test('still blocks a fabricated price when deriveStateAsync resolves null instead of rejecting', async () => {
    // Distinct from the rejection case: enforce() early-returns
    // { allowed: true } on a falsy stateResult, so a null resolution would
    // silently disable the fabrication check without any error being logged.
    // The fallback must cover resolved-null, not just a thrown error.
    deriveStateAsync.mockResolvedValue(null);
    const bot = botReplying(`Sure! That will be ₹${FABRICATED} total.`);
    const result = await bot.processMessage('919876543210', '100 square coasters for resale, what is the price', 'text');

    expect(result.response).not.toContain(FABRICATED);
    expect(result.response).toContain(REAL_TOTAL);
  });

  test('still blocks a fabricated price even when deriveStateAsync itself fails', async () => {
    // The critical case the fallback state exists for: state derivation
    // hiccups, but the fabrication check must not be disabled as a side
    // effect. This is where this wiring improves on the main bot's own
    // call site, which skips enforce() entirely on this failure path.
    deriveStateAsync.mockRejectedValue(new Error('Groq timeout'));
    const bot = botReplying(`Sure! That will be ₹${FABRICATED} total.`);
    const result = await bot.processMessage('919876543210', '100 square coasters for resale, what is the price', 'text');

    expect(result.response).not.toContain(FABRICATED);
    expect(result.response).toContain(REAL_TOTAL);
  });
});
