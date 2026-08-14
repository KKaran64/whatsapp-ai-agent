process.env.MONGODB_ENCRYPTION_KEY = process.env.MONGODB_ENCRYPTION_KEY || 'a'.repeat(64);

const ResponderAgent = require('../../optimized-bot/responder-agent');
const { computeQuote, formatQuoteForCustomer } = require('../../pricing/quote-engine');

// Build the fixture from the real engine rather than hand-rolling an object
// literal: formatQuoteForCustomer() dereferences quote.product.name and
// quote.perPiece, so a partial mock throws instead of asserting. Using the
// real engine also keeps this test honest if the quote shape ever changes.
// 'square coaster' is chosen because it resolves to exactly one catalog
// entry — broader queries like 'coasters' match 36 products and come back
// { found: false, error: 'multiple_matches' }.
const REAL_QUOTE = computeQuote({
  productQuery: 'square coaster',
  quantity: 100,
  customerType: 'reseller'
});

describe('ResponderAgent injects a verified quote into the LLM prompt', () => {
  let responder;
  let mockCreate;

  beforeEach(() => {
    responder = new ResponderAgent({ GROQ_API_KEY: 'test-key' });
    mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'Sure, here is your quote!' } }]
    });
    responder.groqClients = [{ chat: { completions: { create: mockCreate } } }];
    responder.currentKeyIndex = 0;
  });

  test('the fixture is a real, complete quote (guards the tests below)', () => {
    expect(REAL_QUOTE.found).toBe(true);
    expect(REAL_QUOTE.product.name).toBe('SQUARE COASTER');
    expect(formatQuoteForCustomer(REAL_QUOTE)).toContain('1,575');
  });

  test('includes a [VERIFIED QUOTE] line in the system prompt when a quote is passed', async () => {
    const state = { current_node: 'QUOTE_REQUEST', product_interest: ['coasters'], qualifiers: {} };

    await responder.generateResponse('QUOTE_REQUEST', state, 'what is the price', [], REAL_QUOTE);

    const systemPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toMatch(/\[VERIFIED QUOTE/);
    expect(systemPrompt).toContain(formatQuoteForCustomer(REAL_QUOTE));
  });

  test('omits the block entirely when no quote is passed (undefined default)', async () => {
    const state = { current_node: 'QUOTE_REQUEST', product_interest: ['coasters'], qualifiers: {} };
    await responder.generateResponse('QUOTE_REQUEST', state, 'what is the price', []);

    const systemPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).not.toMatch(/\[VERIFIED QUOTE/);
  });

  test('omits the block when quote.found is false', async () => {
    const state = { current_node: 'QUOTE_REQUEST', product_interest: ['coasters'], qualifiers: {} };
    await responder.generateResponse('QUOTE_REQUEST', state, 'what is the price', [], { found: false });

    const systemPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).not.toMatch(/\[VERIFIED QUOTE/);
  });
});
