// botQuotedPrice tested /₹\s*\d{2,}/ — two or more CONSECUTIVE digits.
// Against "₹9,999" that matches "₹9", hits the comma and stops, so the test
// fails. Every state rule built on this detector — "don't quote before
// quantity", "don't quote during greeting", "don't re-quote after the payment
// block" — was therefore inert for any amount from ₹1,000 up.
//
// In Indian digit grouping that is every bulk order, and formatQuoteForCustomer
// writes amounts with toLocaleString('en-IN'), so real bot output always
// carries the comma. The guard looked present and did nothing precisely where
// the money was largest.
//
// Note the asymmetry this closes: extractRupeeAmounts() in the same file was
// already comma-aware, which is why the fabricated-amount check worked while
// these checks silently did not.

const {
  enforce,
  botQuotedPrice,
  botListedProductsWithPrices
} = require('../pricing/state-enforcer');

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('botQuotedPrice sees comma-grouped amounts', () => {
  test.each([
    ['That will be ₹9,999 total.', true],
    ['it costs ₹1,575 incl GST', true],
    ['the total would come out to ₹1,26,900 incl. GST', true],
    ['₹9999 total', true],   // already worked — must not regress
    ['₹15 per piece', true],
    ['₹ 250 each', true]
  ])('%s -> %s', (text, expected) => {
    expect(botQuotedPrice(text)).toBe(expected);
  });

  test('still needs an assertion word, not merely an amount', () => {
    // Keeps incidental mentions from tripping the state rules.
    expect(botQuotedPrice('our range starts around ₹1,200')).toBe(false);
  });

  test('a single-digit amount is still ignored (the old 2-digit intent)', () => {
    expect(botQuotedPrice('₹5 per piece')).toBe(false);
  });

  test('text with no amount is not a quote', () => {
    expect(botQuotedPrice('How many pieces do you need?')).toBe(false);
  });
});

describe('botListedProductsWithPrices sees comma-grouped price lists', () => {
  test('a two-item list with grouped amounts is detected', () => {
    const reply = '1. Diary ₹1,350 2. Coaster set ₹1,200 — which option interests you?';
    expect(botListedProductsWithPrices(reply)).toBe(true);
  });
});

describe('the state rules built on it now actually fire', () => {
  test('AWAITING_QUANTITY blocks a comma-formatted quote', () => {
    const r = enforce({ code: 'AWAITING_QUANTITY', reason: 'test' }, 'Sure! That will be ₹9,999 total.');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('quoted_before_quantity');
    expect(r.reply).not.toContain('9,999');
  });

  test('GREETING blocks a comma-formatted quote', () => {
    const r = enforce({ code: 'GREETING', reason: 'test' }, 'Welcome! Our diaries are ₹1,350 each.');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('quoted_too_early');
  });

  test('a normal greeting with no price is untouched', () => {
    const reply = 'Welcome to 9 Cork! What brings you here today?';
    const r = enforce({ code: 'GREETING', reason: 'test' }, reply);
    expect(r.allowed).toBe(true);
    expect(r.reply).toBe(reply);
  });
});
