// Regression test for the motivating bug (spec 2026-07-05):
//   customer: "I need 200 mats for office" → bot lists 3 mats
//   customer: "for office work desktop mats are better right" → bot agrees
//   customer: "what are the other options?" → OLD bot forgot the refinement
//                                             and listed all 3 mats again.
// With LLM-first extraction the refinement survives because it is re-derived
// from the conversation window every turn, and the engine turns it into a
// single decisive match.

jest.mock('../pricing/groq-client', () => ({
  callGroqJson: jest.fn(),
  DEFAULT_BUDGET_MS: 3000
}));
const { callGroqJson } = require('../pricing/groq-client');
const { resolveIntent } = require('../pricing/intent-resolver');
const { computeQuote } = require('../pricing/quote-engine');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

let savedResolverMode;
beforeEach(() => {
  // This test pins LLM-path behavior — make it deterministic even when the
  // ambient environment has the INTENT_RESOLVER=regex kill-switch set.
  savedResolverMode = process.env.INTENT_RESOLVER;
  delete process.env.INTENT_RESOLVER;
});
afterEach(() => {
  if (savedResolverMode === undefined) delete process.env.INTENT_RESOLVER;
  else process.env.INTENT_RESOLVER = savedResolverMode;
});

const CONVERSATION = [
  { role: 'user', content: 'i need 200 mats for office, for my own use' },
  { role: 'assistant', content: 'We have Coffee Mat, Rubberized Desktop Mat, Yoga Mat — which one?' },
  { role: 'user', content: 'for office work desktop mats are better right' },
  { role: 'assistant', content: 'Yes, desktop mats are a great choice for office use!' }
];

test('refinement survives the "other options" turn and yields a single desktop-mat quote', async () => {
  // What the LLM extracts from the full window on the "other options" turn —
  // the refinement is still visible in the conversation, so it stays extracted.
  callGroqJson.mockResolvedValue({
    productQuery: 'mat',
    refinements: ['desktop', 'office'],
    quantity: 200,
    customerType: 'end_consumer',
    branding: null,
    confidence: 0.9,
    reasoning: 'desktop mats for own office use; refinement retained'
  });

  const intent = await resolveIntent('what are the other options?', CONVERSATION);

  expect(intent.refinements).toContain('desktop');

  const quote = computeQuote(intent);

  // The OLD pipeline returned multiple_matches here (the loop). Now the
  // refinement makes the engine decisive.
  expect(quote.found).toBe(true);
  expect(quote.product.name.toLowerCase()).toContain('desktop');
  expect(quote.quantity).toBe(200);
  expect(quote.grandTotal).toBeGreaterThan(0);
});

test('without the refinement the same query is still ambiguous (sanity check)', () => {
  const quote = computeQuote({
    productQuery: 'mat', quantity: 200, customerType: 'end_consumer', refinements: []
  });
  expect(quote.found).toBe(false);
  expect(quote.error).toBe('multiple_matches');
});
