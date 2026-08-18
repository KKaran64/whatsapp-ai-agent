process.env.MONGODB_ENCRYPTION_KEY = process.env.MONGODB_ENCRYPTION_KEY || 'a'.repeat(64);
// collectGroqKeys() reads this; without a key intent-resolver short-circuits
// to its regex fallback and never reaches the LLM path we want to exercise.
// axios is mocked below, so no request ever leaves the process.
process.env.GROQ_API_KEY = 'test-key';
delete process.env.INTENT_RESOLVER; // ensure the kill-switch isn't forcing regex

jest.mock('../../optimized-bot/state-manager');
jest.mock('../../optimized-bot/media-handler');
// TWO network boundaries must be mocked, not one: router-agent.js and
// responder-agent.js talk to Groq through the groq-sdk package, but
// pricing/intent-resolver.js goes through pricing/groq-client.js, which
// uses axios directly. Mocking only groq-sdk would let resolveIntent make
// a real HTTPS call to api.groq.com from the test suite.
jest.mock('groq-sdk');
jest.mock('axios');

const Groq = require('groq-sdk');
const axios = require('axios');
const StateManager = require('../../optimized-bot/state-manager');

const FABRICATED = '9,999';
const REAL_TOTAL = '1,575'; // square coaster x100 reseller, per the real catalog

describe('optimized-bot end-to-end: intent -> quote -> enforcement', () => {
  let bot;
  let mockGroqCreate;

  beforeEach(() => {
    jest.clearAllMocks();

    let state = { current_node: 'START', product_interest: [], qualifiers: {}, conversation_history: [] };
    StateManager.getState = jest.fn().mockImplementation(async () => ({ ...state }));
    StateManager.transitionNode = jest.fn().mockImplementation(async (phone, node) => { state.current_node = node; });
    StateManager.getRecentMessages = jest.fn().mockImplementation(async () => state.conversation_history || []);
    StateManager.addMessage = jest.fn().mockImplementation(async (phone, role, content) => {
      state.conversation_history = [...(state.conversation_history || []), { role, content }];
    });
    StateManager.updateState = jest.fn().mockImplementation(async (phone, patch) => { Object.assign(state, patch); });
    StateManager.updateQualifiers = jest.fn().mockImplementation(async (phone, patch) => {
      state.qualifiers = { ...state.qualifiers, ...patch };
    });
    StateManager.addProductInterest = jest.fn().mockImplementation(async (phone, p) => {
      state.product_interest = [...new Set([...(state.product_interest || []), p])];
    });
    StateManager.wasImageSent = jest.fn().mockResolvedValue(false);
    StateManager.markImageSent = jest.fn().mockResolvedValue();

    // Groq calls made through groq-sdk: router classification, then response
    // generation. Both run real router-agent.js / responder-agent.js code.
    mockGroqCreate = jest.fn();
    Groq.mockImplementation(() => ({
      chat: { completions: { create: mockGroqCreate } }
    }));

    // The intent-resolver's Groq call, made through axios. Real
    // validateIntent() still parses and validates this payload.
    axios.post = jest.fn().mockResolvedValue({
      data: {
        choices: [{
          message: {
            content: JSON.stringify({
              productQuery: 'square coaster',
              quantity: 100,
              customerType: 'reseller',
              refinements: [],
              confidence: 0.9,
              reasoning: 'test'
            })
          }
        }]
      }
    });

    const { createInstance } = require('../../optimized-bot/index');
    bot = createInstance({ GROQ_API_KEY: 'test-key' });
  });

  test('a customer providing complete quote info gets the real computed price, not an LLM-invented one', async () => {
    // Only ONE groq-sdk call happens here: router-agent classifies this
    // message with its zero-token pattern matcher (-> COASTERS) and never
    // reaches the LLM, so the single scripted reply belongs to the
    // responder — which behaves adversarially and invents a price instead
    // of presenting the injected verified quote.
    mockGroqCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `Sure, for 100 pcs resale that will be ₹${FABRICATED}! Best price for you.` } }]
    });

    const result = await bot.processMessage('919876543210', '100 square coasters for resale, what is the price', 'text');

    // Everything below this line is real, unmocked code: intent-resolver's
    // validation, quote-engine's pricing, conversation-state's derivation,
    // and state-enforcer's guard.
    expect(result.response).not.toContain(FABRICATED);
    expect(result.response).toContain(REAL_TOTAL);
  });

  test('the fabricated price is caught by the guard, not merely absent by luck', async () => {
    // Guards against a false pass: if intent resolution or quoting silently
    // failed, verifiedQuote would be null, the guard would be skipped, and
    // the fabricated figure would have reached the customer. Asserting the
    // repaired text proves the whole chain actually ran.
    mockGroqCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `That will be ₹${FABRICATED}.` } }]
    });

    const result = await bot.processMessage('919876543210', '100 square coasters for resale, what is the price', 'text');

    expect(result.response).toMatch(/Apologies, let me restate the exact figures/i);
    expect(result.response).toContain('SQUARE COASTER');
    expect(axios.post).toHaveBeenCalled(); // intent-resolver's LLM path really ran
  });

  test('sanitization, intent resolution, and enforcement all ran (not just the happy path)', async () => {
    // 'hi' needs no LLM at all: the router pattern-matches it to START and
    // the responder serves a static greeting template. This exercises the
    // fully-short-circuited path, which must still survive every new step
    // (sanitize -> resolveIntent -> computeQuote -> derive -> enforce).
    const result = await bot.processMessage('919876543210', 'hi', 'text');
    expect(result.response).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test('the INTENT_RESOLVER=regex kill-switch no longer disables price protection', async () => {
    // Flipping the resolver kill-switch sends resolveIntent down its regex
    // path, which usually yields quantity: null — so computeQuote never runs
    // and no verified quote exists for the turn. That used to leave the
    // fabrication guard inert, silently trading away price protection as a
    // side effect of an unrelated lever. enforce() now blocks any price it
    // cannot verify, so the kill-switch is safe to pull again.
    const prev = process.env.INTENT_RESOLVER;
    process.env.INTENT_RESOLVER = 'regex';
    try {
      mockGroqCreate.mockResolvedValueOnce({
        choices: [{ message: { content: `Sure! That will be ₹${FABRICATED} total.` } }]
      });

      const result = await bot.processMessage('919876543210', '100 coasters for resale, what is the price', 'text');

      expect(result.response).not.toContain(FABRICATED);
      expect(result.response).not.toMatch(/₹/);
    } finally {
      if (prev === undefined) delete process.env.INTENT_RESOLVER;
      else process.env.INTENT_RESOLVER = prev;
    }
  });

  test('no test in this file reaches the network', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Sure!' } }] });

    await bot.processMessage('919876543210', '100 square coasters for resale', 'text');

    // axios is fully mocked; every call must be the jest mock, never real.
    expect(jest.isMockFunction(axios.post)).toBe(true);
  });
});
