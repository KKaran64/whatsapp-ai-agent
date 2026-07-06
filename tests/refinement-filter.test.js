// Intent-driven image selection (spec 2026-07-06).
//
// Live incident: "share picture of magnetic planter" sent 8 assorted planter
// images. The image path's category router discarded "magnetic" (broad
// 'PLANTER' bucket + hardcoded size-only modifier filter). This module gives
// the image path the same refinement-narrowing semantics the quote engine
// uses for pricing — with prefix-tolerant token matching so 'magnetic'
// matches both MAGNETIC and MAGNET product names.

const { filterByRefinements, selectImageSearch } = require('../pricing/refinement-filter');

// The exact 8 planters from the 2026-07-06 live transcript, plus the one the
// customer actually wanted.
const TRANSCRIPT_PLANTERS = [
  { name: 'CYLINDRICAL PLANTER' },
  { name: 'EMBER PLANTER' },
  { name: 'TRI EDGE PLANTER' },
  { name: 'CORK CONICAL FLASK PLANTER' },
  { name: 'FRIDGE MAGNET PLANTER' },
  { name: 'DONUT PLANTER' },
  { name: 'RECTANGULAR TEST TUBE PLANTER' },
  { name: 'FEATHER PLANTER' },
  { name: 'SMALL MAGNETIC PLANTER' }
];

describe('filterByRefinements — the live-transcript pin', () => {
  test('"magnetic" narrows 9 planters to only the MAGNET/MAGNETIC ones', () => {
    const result = filterByRefinements(TRANSCRIPT_PLANTERS, ['magnetic']);
    expect(result.map(p => p.name).sort()).toEqual([
      'FRIDGE MAGNET PLANTER',
      'SMALL MAGNETIC PLANTER'
    ]);
  });
});

describe('filterByRefinements — semantics (mirrors quote-engine narrowing)', () => {
  test('empty refinements → items unchanged (identity)', () => {
    expect(filterByRefinements(TRANSCRIPT_PLANTERS, [])).toEqual(TRANSCRIPT_PLANTERS);
    expect(filterByRefinements(TRANSCRIPT_PLANTERS, undefined)).toEqual(TRANSCRIPT_PLANTERS);
  });

  test('refinement matching NOTHING is ignored (no false empty result)', () => {
    const result = filterByRefinements(TRANSCRIPT_PLANTERS, ['holographic']);
    expect(result).toEqual(TRANSCRIPT_PLANTERS);
  });

  test('negative refinement always excludes', () => {
    const result = filterByRefinements(TRANSCRIPT_PLANTERS, ['!test']);
    expect(result.every(p => !/\btest\b/i.test(p.name))).toBe(true);
    expect(result.length).toBe(TRANSCRIPT_PLANTERS.length - 1);
  });

  test('positive + negative combine', () => {
    const result = filterByRefinements(TRANSCRIPT_PLANTERS, ['planter', '!magnet']);
    expect(result.some(p => /magnet/i.test(p.name))).toBe(false);
    expect(result.length).toBeGreaterThan(0);
  });

  test('custom getName accessor works', () => {
    const items = [{ title: 'SMALL MAGNETIC PLANTER' }, { title: 'DONUT PLANTER' }];
    const result = filterByRefinements(items, ['magnetic'], i => i.title);
    expect(result).toEqual([{ title: 'SMALL MAGNETIC PLANTER' }]);
  });
});

describe('filterByRefinements — token matching rules', () => {
  const ITEMS = [
    { name: 'ECODESK DIARY A5' },
    { name: 'ECODESK DIARY A6' },
    { name: 'BIG BEN CLOCK' }
  ];

  test('short refinements match exactly (a5)', () => {
    const result = filterByRefinements(ITEMS, ['a5']);
    expect(result).toEqual([{ name: 'ECODESK DIARY A5' }]);
  });

  test('prefix tolerance requires both tokens ≥ 4 chars', () => {
    // 'big' (3 chars) must not prefix-match anything longer; exact still works
    const result = filterByRefinements(ITEMS, ['big']);
    expect(result).toEqual([{ name: 'BIG BEN CLOCK' }]); // exact token match only
  });

  test('prefix tolerance works both directions at ≥4 chars', () => {
    const items = [{ name: 'FRIDGE MAGNET PLANTER' }, { name: 'SMALL MAGNETIC PLANTER' }, { name: 'DONUT PLANTER' }];
    // refinement longer than token
    expect(filterByRefinements(items, ['magnetic']).length).toBe(2);
    // refinement shorter than token
    expect(filterByRefinements(items, ['magnet']).length).toBe(2);
  });
});

describe('selectImageSearch — term selection for the image path', () => {
  const CATEGORY = { code: 'planters_general', mongoSearch: 'PLANTER', hasImages: true };

  test('intent with productQuery → its term + refinements', () => {
    const intent = { productQuery: 'planter', refinements: ['magnetic'], quantity: null, customerType: null };
    expect(selectImageSearch(intent, CATEGORY)).toEqual({
      term: 'planter',
      refinements: ['magnetic'],
      source: 'intent'
    });
  });

  test('null intent → category mongoSearch, no refinements (fallback)', () => {
    expect(selectImageSearch(null, CATEGORY)).toEqual({
      term: 'PLANTER',
      refinements: [],
      source: 'category'
    });
  });

  test('intent without productQuery → category fallback', () => {
    const intent = { productQuery: null, refinements: [], quantity: 400, customerType: 'reseller' };
    expect(selectImageSearch(intent, CATEGORY)).toEqual({
      term: 'PLANTER',
      refinements: [],
      source: 'category'
    });
  });

  test('no category and no productQuery → null (caller keeps legacy path)', () => {
    expect(selectImageSearch(null, null)).toBeNull();
  });
});
