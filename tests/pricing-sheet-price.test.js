// Sheet price cells are not always a single number.
//
// CORK YOGA PEANUT ships in three sizes and the price sheet encodes that as
// ONE cell: DIMENSION "S,M,L" with PRICE "583,750,916". Both parsers in this
// repo stripped non-digits and read that as five hundred eighty-three
// million. It reached production: the live Product collection had
// CORK YOGA PEANUT at ₹35,04,50,550, and it re-corrupted on every sync with
// whatever the current triple happened to be.
//
// Comma-stripping is CORRECT for "3,317" and WRONG for "583,750,916", and
// the two are syntactically identical — "583,750,916" is a perfectly valid
// grouped number. Syntax alone cannot tell them apart, so the variant count
// from the DIMENSION column is used as the disambiguating signal, with a
// plausibility ceiling as a backstop for shapes we have not seen.
//
// We never guess which of S/M/L the customer meant — the row is rejected and
// reported, matching the importer's existing rule that it never invents a
// price.

const {
  parseSheetPrice,
  MAX_PLAUSIBLE_UNIT_PRICE
} = require('../pricing/money');

describe('single-value cells parse as before', () => {
  test.each([
    ['225', 225],
    ['3,317', 3317],
    ['₹1,26,900', 126900],
    [' 1800 ', 1800],
  ])('%s -> %s', (raw, expected) => {
    const r = parseSheetPrice(raw);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(expected);
  });

  test('decimal precision is preserved (sync-pricing relies on it)', () => {
    expect(parseSheetPrice('121.50').value).toBe(121.5);
    expect(parseSheetPrice('17.50').value).toBe(17.5);
  });
});

describe('multi-variant cells are rejected, never guessed', () => {
  test('three prices for three sizes is ambiguous', () => {
    const r = parseSheetPrice('583,750,916', { variantCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/variant/i);
    expect(r.value).toBeUndefined();
  });

  test('two prices for two sizes is ambiguous even though the value looks plausible', () => {
    // 583750 is under the ceiling, so the backstop alone would NOT catch this.
    const r = parseSheetPrice('583,750', { variantCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/variant/i);
  });

  test('a single-variant row with a grouped price is still fine', () => {
    const r = parseSheetPrice('3,317', { variantCount: 1 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(3317);
  });

  test('variant count that does not match the group count falls through to normal parsing', () => {
    // "1,26,900" is one Indian-grouped price, not 3 variants.
    const r = parseSheetPrice('1,26,900', { variantCount: 2 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(126900);
  });
});

describe('plausibility ceiling is the backstop', () => {
  test('rejects an implausible unit price even with no variant hint', () => {
    const r = parseSheetPrice('583,750,916');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/implausible/i);
  });

  test('the real production value would have been rejected', () => {
    expect(parseSheetPrice('350,450,550').ok).toBe(false);
  });

  test('the most expensive real catalogue item is comfortably under the ceiling', () => {
    // NOMAD VAULT / PRO LAPTOP BAG mrp 7500 is the dearest real product.
    expect(MAX_PLAUSIBLE_UNIT_PRICE).toBeGreaterThan(7500 * 10);
    expect(parseSheetPrice('7500').ok).toBe(true);
  });
});

describe('junk and empties', () => {
  test.each(['', '   ', null, undefined, 'abc', '0', '-5'])('%s is rejected', (raw) => {
    expect(parseSheetPrice(raw).ok).toBe(false);
  });
});
