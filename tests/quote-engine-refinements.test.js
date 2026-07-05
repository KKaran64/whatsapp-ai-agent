// Refinement-aware product selection. Uses the REAL catalog via loadCatalog(),
// so assertions are phrased structurally (score ordering, exclusion) rather
// than against exact catalog rows where possible.

const {
  findProducts,
  computeQuote
} = require('../pricing/quote-engine');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

describe('findProducts with refinements', () => {
  test('no refinements → identical result to the one-arg call (regression guard)', () => {
    const before = findProducts('mat');
    const after = findProducts('mat', []);
    expect(after).toEqual(before);
  });

  test('positive refinement boosts matching candidates to the top', () => {
    const plain = findProducts('mat');
    // Meaningful only if "mat" is genuinely ambiguous in the catalog
    expect(plain.length).toBeGreaterThan(1);

    const refined = findProducts('mat', ['desktop']);
    expect(refined[0].name.toLowerCase()).toContain('desktop');
    expect(refined[0].score).toBeGreaterThan(refined[1] ? refined[1].score : 0);
  });

  test('boost never fakes an exact match (capped at 99)', () => {
    const refined = findProducts('mat', ['desktop']);
    const boosted = refined.filter(c => c.name.toLowerCase().includes('desktop'));
    for (const c of boosted) {
      expect(c.score).toBeLessThanOrEqual(99);
    }
  });

  test('negative refinement excludes candidates', () => {
    const refined = findProducts('mat', ['!yoga']);
    expect(refined.every(c => !/\byoga\b/i.test(c.name))).toBe(true);
  });

  test('refinement tokens are stemmed (plural refinement still matches)', () => {
    const refined = findProducts('mat', ['desktops']);
    expect(refined[0].name.toLowerCase()).toContain('desktop');
  });
});

describe('computeQuote with refinements', () => {
  test('ambiguous "mat" becomes a found quote with the desktop refinement', () => {
    const withoutRefinement = computeQuote({
      productQuery: 'mat', quantity: 200, customerType: 'end_consumer'
    });
    expect(withoutRefinement.found).toBe(false);
    expect(withoutRefinement.error).toBe('multiple_matches');

    const withRefinement = computeQuote({
      productQuery: 'mat', quantity: 200, customerType: 'end_consumer',
      refinements: ['desktop']
    });
    expect(withRefinement.found).toBe(true);
    expect(withRefinement.product.name.toLowerCase()).toContain('desktop');
    expect(withRefinement.grandTotal).toBeGreaterThan(0);
  });

  test('refinements that match nothing leave the ambiguity untouched', () => {
    const result = computeQuote({
      productQuery: 'mat', quantity: 200, customerType: 'end_consumer',
      refinements: ['holographic']
    });
    expect(result.found).toBe(false);
    expect(result.error).toBe('multiple_matches');
  });
});
