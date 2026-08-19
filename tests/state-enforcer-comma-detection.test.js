// The price-assertion predicates were comma-blind.
//
// botQuotedPrice() tested /₹\s*\d{2,}/ — two or more CONSECUTIVE digits.
// Against "₹9,999" that matches "₹9" (one digit) and fails. So every state
// rule built on it — "don't quote before quantity is known", "don't re-quote
// after the payment block" — was unenforceable for any amount ≥ ₹1,000,
// which is every bulk order. The guard looked present and did nothing.
//
// Note the asymmetry this fixes: extractRupeeAmounts() in the same file was
// already comma-aware, so the fabricated-amount check worked while the
// quoted-too-early checks silently did not.

const {
  enforce,
  botQuotedPrice,
  botListedProductsWithPrices
} = require('../pricing/state-enforcer');

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('botQuotedPrice detects comma-grouped amounts', () => {
  test.each([
    ['That will be ₹9,999 total.', true],
    ['it costs ₹1,575 incl GST', true],
    ['the total would come out to ₹1,26,900 incl. GST', true],
    ['₹15 per piece', true],           // already worked; must not regress
    ['₹ 250 each', true],
  ])('%s -> %s', (text, expected) => {
    expect(botQuotedPrice(text)).toBe(expected);
  });

  test('still requires an assertion word, not merely an amount', () => {
    // "the bot asserted a price", not "a number appeared" — this keeps
    // incidental mentions from tripping the state rules.
    expect(botQuotedPrice('our range starts around ₹1,200')).toBe(false);
  });

  test('ignores sub-₹10 stray digits, preserving the old two-digit intent', () => {
    expect(botQuotedPrice('₹5 per piece')).toBe(false);
  });
});

describe('botListedProductsWithPrices detects comma-grouped price lists', () => {
  test('a two-item list with comma amounts is detected', () => {
    const reply = '1. Diary ₹1,350 2. Coaster set ₹1,200 — which option interests you?';
    expect(botListedProductsWithPrices(reply)).toBe(true);
  });
});

describe('state rules built on botQuotedPrice now actually fire', () => {
  test('AWAITING_QUANTITY blocks a comma-formatted quote (previously slipped through)', () => {
    const state = { code: 'AWAITING_QUANTITY', reason: 'test' };
    const reply = 'Sure! That will be ₹9,999 total.';

    const result = enforce(state, reply);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('quoted_before_quantity');
    expect(result.reply).not.toContain('9,999');
  });

  test('GREETING blocks a comma-formatted quote', () => {
    const state = { code: 'GREETING', reason: 'test' };
    const result = enforce(state, 'Welcome! Our diaries are ₹1,350 each.');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('quoted_too_early');
  });

  test('a non-price greeting reply is still untouched', () => {
    const state = { code: 'GREETING', reason: 'test' };
    const reply = 'Welcome to 9 Cork! What brings you here today?';
    const result = enforce(state, reply);

    expect(result.allowed).toBe(true);
    expect(result.reply).toBe(reply);
  });
});
