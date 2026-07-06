// Tests for pricing/intent-resolver.js — LLM-first intent extraction.
// The groq-client is mocked at the module boundary; the regex fallback
// (intent-extractor) runs for real so fallback behavior matches production.

jest.mock('../pricing/groq-client', () => ({
  callGroqJson: jest.fn(),
  DEFAULT_BUDGET_MS: 3000
}));
const { callGroqJson } = require('../pricing/groq-client');
const { resolveIntent, getResolverStats } = require('../pricing/intent-resolver');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  callGroqJson.mockReset();
  delete process.env.INTENT_RESOLVER;
});

const CONTEXT = [
  { role: 'user', content: 'i need 200 mats for office, for my own use' },
  { role: 'assistant', content: 'We have Coffee Mat, Desktop Mat, Yoga Mat — which one?' },
  { role: 'user', content: 'for office work desktop mats are better right' }
];

describe('resolveIntent — LLM path', () => {
  test('returns validated intent from the LLM', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'mat',
      refinements: ['desktop', 'office'],
      quantity: 200,
      customerType: 'end_consumer',
      branding: null,
      confidence: 0.9,
      reasoning: 'customer wants desktop mats for own office use'
    });

    const intent = await resolveIntent('what are the other options?', CONTEXT);

    expect(intent).toEqual({
      productQuery: 'mat',
      refinements: ['desktop', 'office'],
      quantity: 200,
      customerType: 'end_consumer',
      branding: null,
      packaging: null,
      confidence: 0.9,
      source: 'llm',
      reasoning: 'customer wants desktop mats for own office use'
    });
  });

  test('returns null when the LLM reports no pricing intent (all business fields null)', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: null, refinements: [], quantity: null,
      customerType: null, branding: null,
      confidence: 0.95, reasoning: 'greeting only'
    });
    const intent = await resolveIntent('hello!', []);
    expect(intent).toBeNull();
  });

  test('coerces and sanitizes malformed fields individually', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: '  diary ',
      refinements: ['A5', 42, '  ', 'premium'],
      quantity: '150',                 // numeric string → number
      customerType: 'wholesaler',      // not in enum → null
      branding: 'glitter',             // not in enum → null
      confidence: '0.8',               // numeric string → number
      reasoning: 'x'.repeat(500)
    });

    const intent = await resolveIntent('150 A5 diaries', []);

    expect(intent.productQuery).toBe('diary');
    expect(intent.refinements).toEqual(['a5', 'premium']);
    expect(intent.quantity).toBe(150);
    expect(intent.customerType).toBeNull();
    expect(intent.branding).toBeNull();
    expect(intent.confidence).toBe(0.8);
    expect(intent.reasoning.length).toBeLessThanOrEqual(200);
  });

  test('nonsense quantity is nulled, not passed through', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'coaster', refinements: [], quantity: 'two hundred',
      customerType: 'reseller', branding: null, confidence: 0.9, reasoning: 'ok'
    });
    const intent = await resolveIntent('coasters', []);
    expect(intent.quantity).toBeNull();
  });

  test('invalid confidence defaults to 0.5', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'coaster', refinements: [], quantity: 10,
      customerType: null, branding: null, confidence: 'very sure', reasoning: 'ok'
    });
    const intent = await resolveIntent('10 coasters', []);
    expect(intent.confidence).toBe(0.5);
  });
});

describe('resolveIntent — regex fallback', () => {
  test('falls back to regex when groq-client returns null, with source flag and confidence 1.0', async () => {
    callGroqJson.mockResolvedValue(null);

    const intent = await resolveIntent('price for 100 cork diaries for my office', []);

    expect(intent.source).toBe('regex_fallback');
    expect(intent.confidence).toBe(1.0);
    expect(intent.refinements).toEqual([]);
    expect(intent.productQuery).toBeTruthy();  // regex extractor found "diary"
    expect(intent.quantity).toBe(100);
    expect(intent.customerType).toBe('end_consumer');
  });

  test('fallback returns null for non-pricing chatter (same as regex today)', async () => {
    callGroqJson.mockResolvedValue(null);
    const intent = await resolveIntent('thanks, bye!', []);
    expect(intent).toBeNull();
  });

  test('kill-switch INTENT_RESOLVER=regex skips the LLM entirely', async () => {
    process.env.INTENT_RESOLVER = 'regex';
    const intent = await resolveIntent('price for 100 cork diaries for my office', []);
    expect(callGroqJson).not.toHaveBeenCalled();
    expect(intent.source).toBe('regex_fallback');
  });
});

describe('getResolverStats', () => {
  test('counts llm successes and regex fallbacks', async () => {
    const before = getResolverStats();

    callGroqJson.mockResolvedValueOnce({
      productQuery: 'mat', refinements: [], quantity: 5,
      customerType: 'reseller', branding: null, confidence: 0.9, reasoning: 'ok'
    });
    await resolveIntent('5 mats', []);

    callGroqJson.mockResolvedValueOnce(null);
    await resolveIntent('price for 100 cork diaries', []);

    const after = getResolverStats();
    expect(after.llm).toBe(before.llm + 1);
    expect(after.regexFallback).toBe(before.regexFallback + 1);
  });
});

describe('packaging extraction', () => {
  test('LLM-extracted individual_boxes passes validation', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'planter', refinements: ['magnetic'], quantity: 400,
      customerType: 'reseller', branding: null, packaging: 'individual_boxes',
      confidence: 0.9, reasoning: 'reseller wants each planter boxed'
    });
    const intent = await resolveIntent('can you pack each one in its own box?', []);
    expect(intent.packaging).toBe('individual_boxes');
  });

  test('unknown packaging value is nulled', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'planter', refinements: [], quantity: 400,
      customerType: 'reseller', branding: null, packaging: 'bubble-wrap',
      confidence: 0.9, reasoning: 'ok'
    });
    const intent = await resolveIntent('bubble wrap please', []);
    expect(intent.packaging).toBeNull();
  });

  test('shipping-method question does NOT set packaging', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'planter', refinements: [], quantity: 400,
      customerType: 'reseller', branding: null, packaging: null,
      confidence: 0.9, reasoning: 'asking how goods ship, not requesting boxes'
    });
    const intent = await resolveIntent('how do you send the goods?', []);
    expect(intent.packaging).toBeNull();
  });

  test('regex fallback catches an explicit individual-boxes request', async () => {
    callGroqJson.mockResolvedValue(null);
    const intent = await resolveIntent('i need 100 cork diaries in individual boxes', []);
    expect(intent.source).toBe('regex_fallback');
    expect(intent.packaging).toBe('individual_boxes');
  });
});
