// Packaging policy (owner decision, 2026-10-03): there is NO individual-box
// charge. Bulk orders ship shrink-wrapped in a master carton; individual
// packing is never priced by the bot — it promises to check and confirm.
//
// The previous rule charged ₹10/pc for "catalogue-section items under ₹500/pc".
// It keyed on an inverted pricing.json section name, so the charge landed on
// HORECA buyers, whom it was written to exempt. These tests pin its absence so
// it cannot return by accident.
const { computeQuote, formatQuoteForCustomer } = require('../pricing/quote-engine');

const BASE = { productQuery: 'small magnetic planter', quantity: 400, customerType: 'reseller' };

describe('packaging is never charged', () => {
  test('requesting individual boxes does not change any total', () => {
    const without = computeQuote(BASE);
    const withBox = computeQuote({ ...BASE, packaging: 'individual_boxes' });
    if (!without.found || !withBox.found) return; // catalog drift guard
    expect(withBox.grandTotal).toBe(without.grandTotal);
    expect(withBox.subtotalEx).toBe(without.subtotalEx);
    expect(withBox.totalGst).toBe(without.totalGst);
  });

  test('packaging detail is flagged for confirmation, never applied', () => {
    const q = computeQuote({ ...BASE, packaging: 'individual_boxes' });
    if (!q.found) return;
    expect(q.packaging).toBeTruthy();
    expect(q.packaging.applied).toBe(false);
    expect(q.packaging.needsConfirmation).toBe(true);
    expect(q.packaging.ratePerPc).toBeUndefined();
  });

  test('the engine no longer exports a packaging rate', () => {
    const engine = require('../pricing/quote-engine');
    expect(engine.PACKAGING_BOX).toBeUndefined();
  });

  test('customer text promises to confirm, and quotes no box price', () => {
    const q = computeQuote({ ...BASE, packaging: 'individual_boxes' });
    if (!q.found) return;
    const line = formatQuoteForCustomer(q);
    expect(line).toMatch(/shrink-wrapped in a master carton/i);
    expect(line).toMatch(/confirm/i);
    expect(line).not.toMatch(/per piece\.\s*$/);
    expect(line).not.toMatch(/Individual boxes: ₹/);
  });

  test('a quote without a packaging request is untouched', () => {
    const q = computeQuote(BASE);
    expect(q.packaging).toBeNull();
  });
});

describe('regression — packaging not requested', () => {
  test('quote shape and totals identical to pre-change', () => {
    const q = computeQuote(BASE);
    expect(q.packaging).toBeNull();
    expect(q.grandTotal).toBe(54600); // transcript-verified figure
  });
});
