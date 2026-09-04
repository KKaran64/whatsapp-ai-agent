// Two real customer messages that produced nothing:
//   "Can I get catalogue for wall tiles"     — no branch matched at all
//   "Can I get catalogue for yoga products"  — no YOGA branch existed, despite
//                                              CONFIG.PDF_CATALOG_YOGA being
//                                              read and a wellness PDF sitting
//                                              in Drive
//
// The routing was a chain of inline `else if`s inside a 4,000-line request
// handler, so it could not be tested and a missing branch was invisible.
// selectCatalogue() is that chain as a pure function.

const { selectCatalogue } = require('../config/catalogues');

describe('requests that previously matched nothing', () => {
  test('wall tiles routes to a wall-covering catalogue', () => {
    const r = selectCatalogue('Can I get catalogue for wall tiles');
    expect(r).not.toBeNull();
    expect(['ELEVATION', 'MINIMALIST']).toContain(r.slot);
  });

  test('yoga products routes to the wellness catalogue', () => {
    const r = selectCatalogue('Can I get catalogue for yoga products');
    expect(r).not.toBeNull();
    expect(r.slot).toBe('YOGA');
  });

  test('wellness is a synonym for yoga', () => {
    expect(selectCatalogue('do you have a wellness catalogue')?.slot).toBe('YOGA');
  });
});

describe('specific categories beat the generic default', () => {
  test.each([
    ['send me the trophy catalogue', 'TROPHY'],
    ['planters catalogue please', 'PLANTERS'],
    ['gifting combo catalogue', 'COMBOS'],
    ['horeca catalogue for my hotel', 'HORECA'],
    ['yoga mat catalogue', 'YOGA'],
    ['festive gifting catalogue', 'FESTIVE'],
  ])('%s -> %s', (msg, slot) => {
    expect(selectCatalogue(msg)?.slot).toBe(slot);
  });

  test('a bare catalogue request falls back to the full product catalogue', () => {
    expect(selectCatalogue('can you send your catalogue')?.slot).toBe('PRODUCTS');
    expect(selectCatalogue('do you have a brochure')?.slot).toBe('PRODUCTS');
  });
});

describe('non-catalogue messages are not hijacked', () => {
  test.each([
    'do you have coasters',
    'what is the price for 100 coasters',
    'hello',
    'yes proceed'
  ])('%s returns null', (msg) => {
    expect(selectCatalogue(msg)).toBeNull();
  });
});

describe('the returned descriptor is ready to send', () => {
  test('carries a fetchable url, a filename and a caption', () => {
    const r = selectCatalogue('yoga catalogue');
    expect(r.url).toMatch(/^https:\/\/drive\.google\.com\/uc\?export=download&id=/);
    expect(r.filename).toMatch(/\.pdf$/i);
    expect(r.caption.length).toBeGreaterThan(0);
  });

  test('every slot the router can return is actually configured', () => {
    const msgs = [
      'trophy catalogue', 'planters catalogue', 'combo catalogue',
      'horeca catalogue', 'yoga catalogue', 'wall tiles catalogue',
      'minimalist catalogue', 'festive catalogue', 'catalogue'
    ];
    for (const m of msgs) {
      const r = selectCatalogue(m);
      expect(r).not.toBeNull();
      expect(r.url).toMatch(/^https:\/\//);
    }
  });
});
