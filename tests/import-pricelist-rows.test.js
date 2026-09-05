// parsePricelistRows is the one place a price sheet row becomes a priced
// product. It is shared by the importer and the price-repair script so the
// two cannot disagree about how a cell is read — the same duplication that
// let one parser be comma-blind while another was not.
//
// Tested against synthetic rows rather than the live sheets: fetching six
// Google sheets takes minutes and depends on Google not throttling, which
// makes it useless as a regression check.

const { parsePricelistRows, norm } = require('../scripts/import-image-links');

const HEADER = ['Product ID', 'PRODUCT NAME', 'Category', 'DIMENSION', 'PRICE FOR 100- 500 pcs'];

function run(rows) {
  const sink = new Map();
  const rejected = [];
  const count = parsePricelistRows([HEADER, ...rows], 'test-sheet', sink, rejected);
  return { sink, rejected, count };
}

describe('the peanut row becomes three priced products', () => {
  test('S, M and L each get their own price and id', () => {
    const { sink, count } = run([
      ['9C-YA12', 'CORK YOGA PEANUT', 'YOGA PEANUT', ' S,M,L', '583,750,916']
    ]);

    expect(count).toBe(3);
    expect(sink.get('CORK YOGA PEANUT S')).toEqual({ price: 583, id: '9C-YA12-S' });
    expect(sink.get('CORK YOGA PEANUT M')).toEqual({ price: 750, id: '9C-YA12-M' });
    expect(sink.get('CORK YOGA PEANUT L')).toEqual({ price: 916, id: '9C-YA12-L' });
  });

  test('the concatenated nine-digit price never appears', () => {
    const { sink } = run([
      ['9C-YA12', 'CORK YOGA PEANUT', 'YOGA PEANUT', ' S,M,L', '583,750,916']
    ]);
    for (const v of sink.values()) {
      expect(v.price).toBeLessThan(100000);
    }
  });
});

describe('ordinary rows are unaffected', () => {
  test('a single price with a plain dimension stays one product', () => {
    const { sink, count } = run([
      ['9C-YA7', 'CORK YOGA BALL', 'YOGA BALL', '55 MM DIA', '225']
    ]);
    expect(count).toBe(1);
    expect(sink.get('CORK YOGA BALL')).toEqual({ price: 225, id: '9C-YA7' });
  });

  test('a grouped price is read whole, not split', () => {
    const { sink } = run([
      ['9C-YB3', 'PREMIUM YOGA KIT BAG', 'YOGA BAG', '', '3,317']
    ]);
    expect(sink.get('PREMIUM YOGA KIT BAG').price).toBe(3317);
  });
});

describe('bad rows are reported, not silently dropped', () => {
  test('a variant-count mismatch is rejected with a reason', () => {
    const { sink, rejected } = run([
      ['9C-X', 'MYSTERY PRODUCT', 'CAT', 'S,M,L', '100,200']
    ]);
    expect(sink.size).toBe(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/variant/i);
  });

  test('rows with an empty price cell are skipped without noise', () => {
    const { sink, rejected } = run([
      ['9C-Y', 'NO PRICE PRODUCT', 'CAT', '', '']
    ]);
    expect(sink.size).toBe(0);
    expect(rejected).toHaveLength(0);
  });
});

describe('norm is exported so callers key names identically', () => {
  test('uppercases and collapses whitespace', () => {
    expect(norm('  cork  yoga   peanut ')).toBe('CORK YOGA PEANUT');
  });
});
