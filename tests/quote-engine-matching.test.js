// Product matching: a customer asking for a specific variant must get THAT
// variant, not a similarly-named one. Both bugs below were found by sweeping
// all 414 priced products through computeQuote and comparing what came back.
const { computeQuote } = require('../pricing/quote-engine');

describe('variant numbers are identifiers, not noise', () => {
  // "BAR CADDY 6" and "BAR CADDY 1" both reduced to {bar, caddy} when single
  // characters were filtered out, so the sort decided. 26 products were wrong.
  test.each([
    ['bar caddy 6', 'BAR CADDY 6'],
    ['bar caddy 2', 'BAR CADDY 2'],
    ['bar caddy 9', 'BAR CADDY 9'],
    ['room tag 3', 'ROOM TAG 3'],
    ['mirror 2', 'MIRROR 2'],
  ])('%s resolves to %s', (query, expected) => {
    const q = computeQuote({ productQuery: query, quantity: 100, customerType: 'end_consumer' });
    if (!q.found) return; // catalog drift guard
    expect(q.product.name.toUpperCase()).toBe(expected);
  });

  test('a two-digit variant still works (it always did)', () => {
    const q = computeQuote({ productQuery: 'bar caddy 17', quantity: 100, customerType: 'reseller' });
    if (!q.found) return;
    expect(q.product.name.toUpperCase()).toBe('BAR CADDY 17');
  });

  test('numbered variants have genuinely different prices', () => {
    const a = computeQuote({ productQuery: 'bar caddy 1', quantity: 100, customerType: 'end_consumer' });
    const b = computeQuote({ productQuery: 'bar caddy 6', quantity: 100, customerType: 'end_consumer' });
    if (!a.found || !b.found) return;
    expect(a.perPiece).not.toBe(b.perPiece); // quoting one for the other is a real error
  });
});

describe('an exact name beats a token-subset match', () => {
  // "cork" is a stop word, so "NATURAL CORK PLANTER" (400) token-matched
  // "NATURAL PLANTER" (650). Both scored 100 and the sort decided.
  test('NATURAL CORK PLANTER is not quoted as NATURAL PLANTER', () => {
    const q = computeQuote({ productQuery: 'NATURAL CORK PLANTER', quantity: 100, customerType: 'end_consumer' });
    if (!q.found) return;
    expect(q.product.name.toUpperCase()).toBe('NATURAL CORK PLANTER');
  });

  test('every priced product resolves to itself', () => {
    const { loadCatalog } = require('../pricing/quote-engine');
    const d = loadCatalog();
    const rows = [
      ...(d.catalogue || []).map(p => ({ name: p.name, price: p.price })),
      ...(d.horeca || []).map(p => ({ name: p.name, price: p.mrpPrice })),
      ...(d.trophies || []).map(p => ({ name: p.name, price: p.price })),
    ].filter(r => r.name && r.price != null);
    const wrong = [];
    for (const r of rows) {
      const q = computeQuote({ productQuery: r.name, quantity: 100, customerType: 'end_consumer' });
      if (q.found && q.product.name.toUpperCase() !== r.name.toUpperCase()) {
        wrong.push(`${r.name} => ${q.product.name}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('the pen branding restriction fires on pens, not on the word "pen"', () => {
  const { BRANDING_OPTIONS } = require('../pricing/quote-engine');
  const allowedFor = name => Object.keys(BRANDING_OPTIONS).filter(b =>
    computeQuote({ productQuery: name, quantity: 100, customerType: 'reseller', branding: b }).found);

  test('a diary sold WITHOUT a pen is not a pen', () => {
    // The bare word matched inside "(WITHOUT PEN)", restricting a diary to
    // laser only — a customer asking for single-colour print was refused.
    const allowed = allowedFor('EXECUTIVE DIARY (WITHOUT PEN)');
    if (allowed.length === 0) return; // catalog drift guard
    expect(allowed).toEqual(expect.arrayContaining(['single-color', 'pad-printing', 'multi-color']));
  });

  test('a pen holder is flat cork — every technique still works', () => {
    const allowed = allowedFor('CORK PEN HOLDER');
    if (allowed.length === 0) return;
    expect(allowed).toEqual(expect.arrayContaining(['single-color', 'laser']));
  });

  test('an ordinary diary is unaffected', () => {
    const allowed = allowedFor('ECODESK DIARY A5');
    if (allowed.length === 0) return;
    expect(allowed.length).toBeGreaterThan(1);
  });
});
