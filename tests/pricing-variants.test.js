// CORK YOGA PEANUT ships in three sizes and the sheet encodes that as one
// row: DIMENSION "S,M,L", PRICE "583,750,916" — ₹583 small, ₹750 medium,
// ₹916 large. That is a deliberate, legitimate encoding of the product, not
// a data-entry mistake.
//
// The first fix stripped non-digits and read it as ₹58 crore, which reached
// production. The second refused the row, which was safe but left the peanut
// with no price at all. Neither is right: the row describes three real
// products, so the importer should expand it into three, using the sizes the
// sheet already declares.
//
// Confirmed against all five price sheets: the peanut is the only row in this
// shape today, so the expansion must be conservative and never fire on an
// ordinary grouped number like "3,317".

const { parseSheetPriceVariants } = require('../pricing/money');

describe('multi-variant rows expand into one product per size', () => {
  test('the peanut row yields S, M and L with their own prices', () => {
    const r = parseSheetPriceVariants('583,750,916', 'S,M,L');
    expect(r.ok).toBe(true);
    expect(r.variants).toEqual([
      { label: 'S', price: 583 },
      { label: 'M', price: 750 },
      { label: 'L', price: 916 }
    ]);
  });

  test('tolerates the spacing the sheet actually contains', () => {
    // The live cell is " S,M,L" with a leading space.
    const r = parseSheetPriceVariants('583, 750, 916', ' S,M,L');
    expect(r.variants.map(v => v.label)).toEqual(['S', 'M', 'L']);
    expect(r.variants.map(v => v.price)).toEqual([583, 750, 916]);
  });
});

describe('ordinary single-price rows are untouched', () => {
  test.each([
    ['3,317', '', 3317],
    ['225', '55 MM DIA', 225],
    ['1,26,900', '24 X 72 INCH', 126900],
    ['121.50', '', 121.5]
  ])('%s with dimension %s -> single price %s', (price, dim, expected) => {
    const r = parseSheetPriceVariants(price, dim);
    expect(r.ok).toBe(true);
    expect(r.variants).toEqual([{ label: null, price: expected }]);
  });

  test('a grouped number with a comma-free dimension never splits', () => {
    // "1,26,900" is one Indian-grouped price. Three comma groups, but the
    // dimension declares no variants, so it must not become three products.
    const r = parseSheetPriceVariants('1,26,900', '24 X 72 INCH');
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0].price).toBe(126900);
  });
});

describe('genuinely ambiguous rows are still refused', () => {
  test('price groups that do not match the declared variant count', () => {
    const r = parseSheetPriceVariants('583,750', 'S,M,L');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/variant/i);
  });

  test('an implausible single value is still rejected', () => {
    const r = parseSheetPriceVariants('583,750,916', '');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/implausible/i);
  });

  test.each(['', null, 'abc', '-5'])('junk %s is rejected', (raw) => {
    expect(parseSheetPriceVariants(raw, '').ok).toBe(false);
  });
});
