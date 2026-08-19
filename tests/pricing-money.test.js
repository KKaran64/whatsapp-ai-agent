// Canonical money parsing — the single source of truth for "what rupee
// amounts appear in this text".
//
// Why this module exists: the codebase had grown seven-plus independent
// ₹-matching regexes and four of them were comma-blind (`₹\s*\d{2,}` and
// `₹\s*(\d+)`), so they silently failed on any amount ≥ ₹1,000 — which in
// Indian digit grouping is every bulk order. The safety guard that is
// supposed to catch a fabricated "₹9,999 total" could not see it at all.
// Every money-detecting caller now delegates here so the two cannot drift
// apart again.

const {
  extractRupeeAmounts,
  hasRupeeAmount,
  parseAmount,
  RUPEE_AMOUNT_SOURCE
} = require('../pricing/money');

describe('parseAmount', () => {
  test('strips Indian comma grouping', () => {
    expect(parseAmount('9,999')).toBe(9999);
    expect(parseAmount('1,26,900')).toBe(126900); // lakh grouping
    expect(parseAmount('15')).toBe(15);
  });

  test('handles decimals and returns null for junk', () => {
    expect(parseAmount('1,575.50')).toBe(1575.5);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe('extractRupeeAmounts', () => {
  test('finds comma-grouped amounts — the whole point of this module', () => {
    expect(extractRupeeAmounts('That will be ₹9,999 total.')).toEqual([9999]);
    expect(extractRupeeAmounts('₹1,575 incl. GST')).toEqual([1575]);
    expect(extractRupeeAmounts('total ₹1,26,900 incl. GST')).toEqual([126900]);
  });

  test('finds plain and spaced amounts', () => {
    expect(extractRupeeAmounts('₹15 per piece')).toEqual([15]);
    expect(extractRupeeAmounts('₹ 250 each')).toEqual([250]);
  });

  test('finds several amounts in order', () => {
    expect(extractRupeeAmounts('₹15 per piece, total ₹1,575')).toEqual([15, 1575]);
  });

  test('returns empty for text with no amounts', () => {
    expect(extractRupeeAmounts('How many pieces do you need?')).toEqual([]);
    expect(extractRupeeAmounts('')).toEqual([]);
    expect(extractRupeeAmounts(null)).toEqual([]);
  });
});

describe('hasRupeeAmount', () => {
  test('detects comma-grouped amounts that the old ₹\\s*\\d{2,} regex missed', () => {
    // These three are the exact regressions that motivated this module.
    expect(hasRupeeAmount('That will be ₹9,999 total.')).toBe(true);
    expect(hasRupeeAmount('it costs ₹1,575 incl GST')).toBe(true);
    expect(hasRupeeAmount('total would come out to ₹1,26,900 incl. GST')).toBe(true);
  });

  test('honours a minimum value, preserving the old two-digit intent', () => {
    // The original regex required 2+ digits, i.e. >= 10. Callers that want
    // that behaviour ask for it explicitly instead of encoding it in a regex.
    expect(hasRupeeAmount('₹5', 10)).toBe(false);
    expect(hasRupeeAmount('₹15', 10)).toBe(true);
    expect(hasRupeeAmount('₹9,999', 10)).toBe(true);
  });

  test('is false when there is no amount at all', () => {
    expect(hasRupeeAmount('no prices here')).toBe(false);
  });
});

describe('RUPEE_AMOUNT_SOURCE', () => {
  test('is a composable source string so callers never hand-roll the number part', () => {
    expect(typeof RUPEE_AMOUNT_SOURCE).toBe('string');
    // A caller composing a "per piece" pattern must still match commas.
    const perPiece = new RegExp(`₹\\s*(${RUPEE_AMOUNT_SOURCE})\\s*(?:per|/|each)\\s*(?:piece|pc)\\b`, 'i');
    const m = '₹1,575 per piece'.match(perPiece);
    expect(m).not.toBeNull();
    expect(parseAmount(m[1])).toBe(1575);
  });
});
