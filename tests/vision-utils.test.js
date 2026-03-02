const {
  hammingDistance,
  isCorkColor,
  isCorkColorHSL,
  rgbToHsl,
  getCategoryDisplayName,
  matchToCategory,
  detectWhiteBackground,
  histogramHasCorkBins,
  CORK_COLORS,
  CATEGORY_KEYWORDS,
  PRODUCT_SHAPES
} = require('../vision-utils');

// ─── hammingDistance ──────────────────────────────────────────────────────────

describe('hammingDistance', () => {
  test('returns 0 for identical hashes', () => {
    expect(hammingDistance('1010101010', '1010101010')).toBe(0);
  });

  test('returns correct distance for different hashes', () => {
    expect(hammingDistance('1111', '0000')).toBe(4);
    expect(hammingDistance('1100', '1010')).toBe(2);
    expect(hammingDistance('1000', '1001')).toBe(1);
  });

  test('returns Infinity for different length hashes', () => {
    expect(hammingDistance('111', '1111')).toBe(Infinity);
  });

  test('returns Infinity for null/undefined', () => {
    expect(hammingDistance(null, '1010')).toBe(Infinity);
    expect(hammingDistance('1010', null)).toBe(Infinity);
    expect(hammingDistance(null, null)).toBe(Infinity);
    expect(hammingDistance(undefined, '1010')).toBe(Infinity);
  });

  test('returns 0 for two empty strings', () => {
    expect(hammingDistance('', '')).toBe(0);
  });
});

// ─── isCorkColor ─────────────────────────────────────────────────────────────

describe('isCorkColor', () => {
  test('identifies natural cork color', () => {
    const result = isCorkColor({ r: 175, g: 140, b: 95 });
    expect(result.isCork).toBe(true);
    expect(result.type).toBe('natural');
    expect(result.confidence).toBe(0.7);
  });

  test('identifies dark cork color', () => {
    const result = isCorkColor({ r: 125, g: 95, b: 65 });
    expect(result.isCork).toBe(true);
    expect(result.type).toBe('dark');
  });

  test('identifies light cork color', () => {
    const result = isCorkColor({ r: 205, g: 175, b: 125 });
    expect(result.isCork).toBe(true);
    expect(result.type).toBe('light');
  });

  test('rejects non-cork colors', () => {
    expect(isCorkColor({ r: 0, g: 0, b: 255 }).isCork).toBe(false); // Blue
    expect(isCorkColor({ r: 255, g: 0, b: 0 }).isCork).toBe(false); // Red
    expect(isCorkColor({ r: 0, g: 255, b: 0 }).isCork).toBe(false); // Green
    expect(isCorkColor({ r: 255, g: 255, b: 255 }).isCork).toBe(false); // White
    expect(isCorkColor({ r: 0, g: 0, b: 0 }).isCork).toBe(false); // Black
  });

  test('returns confidence 0 for non-cork', () => {
    expect(isCorkColor({ r: 0, g: 0, b: 255 }).confidence).toBe(0);
  });
});

// ─── isCorkColorHSL ──────────────────────────────────────────────────────────

describe('isCorkColorHSL', () => {
  test('identifies natural cork HSL', () => {
    const result = isCorkColorHSL({ h: 30, s: 50, l: 55 });
    expect(result.isCork).toBe(true);
    expect(result.type).toBe('natural');
  });

  test('identifies dark cork HSL', () => {
    const result = isCorkColorHSL({ h: 25, s: 60, l: 35 });
    expect(result.isCork).toBe(true);
    expect(result.type).toBe('dark');
  });

  test('identifies partial match by hue range', () => {
    const result = isCorkColorHSL({ h: 42, s: 10, l: 95 }); // Cork hue but non-matching s/l
    expect(result.isCork).toBe(true);
    expect(result.type).toBe('possible');
    expect(result.confidence).toBe(0.4);
  });

  test('rejects non-cork HSL', () => {
    expect(isCorkColorHSL({ h: 240, s: 100, l: 50 }).isCork).toBe(false); // Blue
    expect(isCorkColorHSL({ h: 0, s: 100, l: 50 }).isCork).toBe(false); // Red
    expect(isCorkColorHSL({ h: 120, s: 100, l: 50 }).isCork).toBe(false); // Green
  });
});

// ─── rgbToHsl ────────────────────────────────────────────────────────────────

describe('rgbToHsl', () => {
  test('converts white correctly', () => {
    const { h, s, l } = rgbToHsl(255, 255, 255);
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(l).toBe(100);
  });

  test('converts black correctly', () => {
    const { h, s, l } = rgbToHsl(0, 0, 0);
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(l).toBe(0);
  });

  test('converts pure red correctly', () => {
    const { h, s, l } = rgbToHsl(255, 0, 0);
    expect(h).toBe(0);
    expect(s).toBe(100);
    expect(l).toBe(50);
  });

  test('converts pure green correctly', () => {
    const { h, s, l } = rgbToHsl(0, 255, 0);
    expect(h).toBe(120);
    expect(s).toBe(100);
    expect(l).toBe(50);
  });

  test('converts pure blue correctly', () => {
    const { h, s, l } = rgbToHsl(0, 0, 255);
    expect(h).toBe(240);
    expect(s).toBe(100);
    expect(l).toBe(50);
  });

  test('converts cork-like color', () => {
    const { h, s, l } = rgbToHsl(175, 140, 95);
    expect(h).toBeGreaterThanOrEqual(20);
    expect(h).toBeLessThanOrEqual(40);
    expect(s).toBeGreaterThan(0);
    expect(l).toBeGreaterThan(30);
    expect(l).toBeLessThan(70);
  });

  test('returns integers', () => {
    const { h, s, l } = rgbToHsl(123, 45, 67);
    expect(Number.isInteger(h)).toBe(true);
    expect(Number.isInteger(s)).toBe(true);
    expect(Number.isInteger(l)).toBe(true);
  });
});

// ─── getCategoryDisplayName ──────────────────────────────────────────────────

describe('getCategoryDisplayName', () => {
  test('returns correct display names', () => {
    expect(getCategoryDisplayName('coaster')).toBe('coaster');
    expect(getCategoryDisplayName('diary')).toBe('diary/notebook');
    expect(getCategoryDisplayName('organizer')).toBe('desk organizer');
    expect(getCategoryDisplayName('cardholder')).toBe('card holder');
    expect(getCategoryDisplayName('planter')).toBe('planter');
    expect(getCategoryDisplayName('bag')).toBe('bag');
    expect(getCategoryDisplayName('wallet')).toBe('wallet');
    expect(getCategoryDisplayName('frame')).toBe('photo frame');
    expect(getCategoryDisplayName('clock')).toBe('clock');
    expect(getCategoryDisplayName('mousepad')).toBe('mouse pad');
    expect(getCategoryDisplayName('yogamat')).toBe('yoga mat');
  });

  test('returns "product" for unknown category', () => {
    expect(getCategoryDisplayName('unknown')).toBe('product');
    expect(getCategoryDisplayName('nonexistent')).toBe('product');
  });
});

// ─── matchToCategory ─────────────────────────────────────────────────────────

describe('matchToCategory', () => {
  test('returns unknown for null features', () => {
    const result = matchToCategory(null);
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  test('boosts coaster/clock for square images', () => {
    const features = {
      aspectRatio: 1.0,
      shape: 'square',
      isCorkColored: { isCork: false },
      isSimple: false,
      histogram: null
    };
    const result = matchToCategory(features);
    expect(result.scores.coaster).toBeGreaterThan(0);
    expect(result.scores.clock).toBeGreaterThan(0);
  });

  test('boosts diary/frame for portrait images', () => {
    const features = {
      aspectRatio: 0.7,
      shape: 'portrait',
      isCorkColored: { isCork: false },
      isSimple: false,
      histogram: null
    };
    const result = matchToCategory(features);
    expect(result.scores.diary).toBeGreaterThan(0);
    expect(result.scores.frame).toBeGreaterThan(0);
  });

  test('boosts all cork categories when cork-colored', () => {
    const features = {
      aspectRatio: 1.0,
      shape: 'square',
      isCorkColored: { isCork: true },
      isSimple: false,
      histogram: null
    };
    const result = matchToCategory(features);
    // All categories should have a cork boost
    for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
      expect(result.scores[cat]).toBeGreaterThan(0);
    }
  });

  test('boosts logo for simple non-white-bg images', () => {
    const features = {
      aspectRatio: 1.0,
      shape: 'square',
      isCorkColored: { isCork: false },
      isSimple: true,
      histogram: null
    };
    const result = matchToCategory(features, null, false);
    expect(result.scores.logo).toBeGreaterThan(0);
  });

  test('does NOT boost logo for white background images', () => {
    const features = {
      aspectRatio: 1.0,
      shape: 'square',
      isCorkColored: { isCork: false },
      isSimple: true,
      histogram: null
    };
    const result = matchToCategory(features, null, true);
    expect(result.scores.logo || 0).toBe(0);
  });

  test('caps confidence at 1.0', () => {
    const features = {
      aspectRatio: 1.0,
      shape: 'square',
      isCorkColored: { isCork: true },
      isSimple: true,
      histogram: { r: [0, 0, 0, 0, 0.3, 0.3, 0.2, 0], g: [0, 0, 0, 0.3, 0.3, 0.2, 0, 0], b: [0, 0, 0.3, 0.3, 0.2, 0, 0, 0] }
    };
    const result = matchToCategory(features);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  test('uses center features for cork detection on white background', () => {
    const features = {
      aspectRatio: 1.0,
      shape: 'square',
      isCorkColored: { isCork: false },
      isSimple: false,
      histogram: null
    };
    const centerFeatures = { isCorkColored: true };
    const result = matchToCategory(features, centerFeatures, true);
    // Center cork on white bg should boost categories
    for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
      expect(result.scores[cat]).toBeGreaterThan(0);
    }
  });
});

// ─── detectWhiteBackground ───────────────────────────────────────────────────

describe('detectWhiteBackground', () => {
  test('returns false for null inputs', () => {
    expect(detectWhiteBackground(null, null).isWhiteBg).toBe(false);
    expect(detectWhiteBackground(null, {}).isWhiteBg).toBe(false);
    expect(detectWhiteBackground({}, null).isWhiteBg).toBe(false);
  });

  test('detects white dominant with white histogram as high confidence', () => {
    const features = { dominant: { rgb: { r: 240, g: 240, b: 240 } } };
    const histogram = {
      r: [0, 0, 0, 0, 0, 0, 0.3, 0.6],
      g: [0, 0, 0, 0, 0, 0, 0.3, 0.6],
      b: [0, 0, 0, 0, 0, 0, 0.3, 0.6]
    };
    const result = detectWhiteBackground(features, histogram);
    expect(result.isWhiteBg).toBe(true);
    expect(result.confidence).toBe(0.95);
  });

  test('detects near-white dominant only as medium confidence', () => {
    const features = { dominant: { rgb: { r: 220, g: 220, b: 220 } } };
    const histogram = {
      r: [0, 0, 0.1, 0.2, 0.3, 0.2, 0.1, 0.1],
      g: [0, 0, 0.1, 0.2, 0.3, 0.2, 0.1, 0.1],
      b: [0, 0, 0.1, 0.2, 0.3, 0.2, 0.1, 0.1]
    };
    const result = detectWhiteBackground(features, histogram);
    expect(result.isWhiteBg).toBe(true);
    expect(result.confidence).toBe(0.7);
  });

  test('returns false for dark backgrounds', () => {
    const features = { dominant: { rgb: { r: 50, g: 50, b: 50 } } };
    const histogram = {
      r: [0.5, 0.3, 0.2, 0, 0, 0, 0, 0],
      g: [0.5, 0.3, 0.2, 0, 0, 0, 0, 0],
      b: [0.5, 0.3, 0.2, 0, 0, 0, 0, 0]
    };
    const result = detectWhiteBackground(features, histogram);
    expect(result.isWhiteBg).toBe(false);
  });
});

// ─── histogramHasCorkBins ────────────────────────────────────────────────────

describe('histogramHasCorkBins', () => {
  test('returns true for cork-heavy histogram', () => {
    const histogram = {
      r: [0, 0, 0, 0, 0.3, 0.3, 0.2, 0],
      g: [0, 0, 0, 0.3, 0.3, 0.2, 0, 0],
      b: [0, 0, 0.3, 0.3, 0.2, 0, 0, 0]
    };
    expect(histogramHasCorkBins(histogram)).toBe(true);
  });

  test('returns false for non-cork histogram', () => {
    const histogram = {
      r: [0, 0, 0, 0, 0, 0, 0, 0.8],
      g: [0, 0, 0, 0, 0, 0, 0, 0.8],
      b: [0, 0, 0, 0, 0, 0, 0, 0.8]
    };
    expect(histogramHasCorkBins(histogram)).toBe(false);
  });

  test('returns false for null histogram', () => {
    expect(histogramHasCorkBins(null)).toBe(false);
    expect(histogramHasCorkBins(undefined)).toBe(false);
  });
});

// ─── Constants sanity checks ─────────────────────────────────────────────────

describe('Vision Constants', () => {
  test('CORK_COLORS has rgb and hsl variants', () => {
    expect(CORK_COLORS.rgb).toBeDefined();
    expect(CORK_COLORS.hsl).toBeDefined();
    expect(CORK_COLORS.rgb.natural).toBeDefined();
    expect(CORK_COLORS.rgb.dark).toBeDefined();
    expect(CORK_COLORS.rgb.light).toBeDefined();
  });

  test('CATEGORY_KEYWORDS covers all product types', () => {
    const expected = ['coaster', 'diary', 'organizer', 'cardholder', 'planter', 'bag', 'wallet', 'frame', 'clock', 'mousepad', 'yogamat'];
    for (const cat of expected) {
      expect(CATEGORY_KEYWORDS[cat]).toBeDefined();
      expect(Array.isArray(CATEGORY_KEYWORDS[cat])).toBe(true);
      expect(CATEGORY_KEYWORDS[cat].length).toBeGreaterThan(0);
    }
  });

  test('PRODUCT_SHAPES have valid aspect ratio ranges', () => {
    for (const [name, shape] of Object.entries(PRODUCT_SHAPES)) {
      expect(shape.aspectRatio).toHaveLength(2);
      expect(shape.aspectRatio[0]).toBeLessThan(shape.aspectRatio[1]);
      expect(shape.boost).toBeGreaterThan(0);
      expect(shape.boost).toBeLessThanOrEqual(1);
    }
  });
});
