// Mock external dependencies
jest.mock('axios');

// Mock vision-utils (sharp dependency)
jest.mock('../vision-utils', () => ({
  calculatePHash: jest.fn(),
  hammingDistance: jest.fn(),
  extractImageFeatures: jest.fn(),
  matchToCategory: jest.fn(),
  detectLogo: jest.fn(),
  getCategoryDisplayName: jest.fn((cat) => {
    const names = {
      coaster: 'coaster', diary: 'diary/notebook', organizer: 'desk organizer',
      bag: 'bag', wallet: 'wallet', frame: 'photo frame', clock: 'clock',
      planter: 'planter', cardholder: 'card holder', mousepad: 'mouse pad',
      yogamat: 'yoga mat', unknown: 'product'
    };
    return names[cat] || 'product';
  }),
  extractCenterRegionFeatures: jest.fn(),
  detectWhiteBackground: jest.fn()
}));

// Stub out the constructor's async side-effects (buildProductHashIndex, _initLocalML)
// which read the real filesystem. We mock these BEFORE requiring the module.
jest.mock('../smart-image-matcher', () => {
  const ActualSmartImageMatcher = jest.requireActual('../smart-image-matcher');
  const OrigProto = ActualSmartImageMatcher.prototype;

  // Replace constructor side-effect methods with no-ops
  OrigProto.buildProductHashIndex = jest.fn().mockResolvedValue(null);
  OrigProto._initLocalML = jest.fn().mockResolvedValue();

  return ActualSmartImageMatcher;
});

const SmartImageMatcher = require('../smart-image-matcher');
const axios = require('axios');
const visionUtils = require('../vision-utils');

// Suppress console noise in tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Constructor & Configuration ────────────────────────────────────────────

describe('SmartImageMatcher - Constructor', () => {
  test('initializes with empty config', () => {
    const matcher = new SmartImageMatcher({});
    expect(matcher.configuredProviders).toEqual([]);
    expect(matcher.indexLoaded).toBe(false);
    expect(matcher.localMLReady).toBe(false);
  });

  test('detects configured providers from config keys', () => {
    const matcher = new SmartImageMatcher({
      CLARIFAI_API_KEY: 'clarifai-key',
      SAMBANOVA_API_KEY: 'samba-key'
    });
    const providerIds = matcher.configuredProviders.map(p => p.id);
    expect(providerIds).toContain('clarifai');
    expect(providerIds).toContain('sambanova');
  });

  test('sorts providers by tier (lower tier first)', () => {
    const matcher = new SmartImageMatcher({
      CLARIFAI_API_KEY: 'key',       // tier 1
      SAMBANOVA_API_KEY: 'key',      // tier 2
      FIREWORKS_API_KEY: 'key'       // tier 2
    });
    expect(matcher.configuredProviders[0].tier).toBe(1);
    expect(matcher.configuredProviders[1].tier).toBe(2);
  });

  test('requires all config keys for multi-key providers', () => {
    // Imagga needs both API_KEY and API_SECRET
    const matcherPartial = new SmartImageMatcher({ IMAGGA_API_KEY: 'key-only' });
    const ids = matcherPartial.configuredProviders.map(p => p.id);
    expect(ids).not.toContain('imagga');

    const matcherFull = new SmartImageMatcher({
      IMAGGA_API_KEY: 'key',
      IMAGGA_API_SECRET: 'secret'
    });
    const fullIds = matcherFull.configuredProviders.map(p => p.id);
    expect(fullIds).toContain('imagga');
  });

  test('initializes stats for all providers', () => {
    const matcher = new SmartImageMatcher({});
    expect(matcher.stats.byProvider.clarifai).toEqual({ success: 0, failures: 0 });
    expect(matcher.stats.byProvider.sambanova).toEqual({ success: 0, failures: 0 });
    expect(matcher.stats.localML).toEqual({ success: 0, failures: 0 });
  });
});

// ─── _mapPredictionToCorkProduct ────────────────────────────────────────────

describe('SmartImageMatcher - _mapPredictionToCorkProduct', () => {
  let matcher;

  beforeEach(() => {
    matcher = new SmartImageMatcher({});
  });

  test('maps direct label matches', () => {
    expect(matcher._mapPredictionToCorkProduct('notebook')).toBe('diary');
    expect(matcher._mapPredictionToCorkProduct('wallet')).toBe('wallet');
    expect(matcher._mapPredictionToCorkProduct('coaster')).toBe('coaster');
    expect(matcher._mapPredictionToCorkProduct('flowerpot')).toBe('planter');
    expect(matcher._mapPredictionToCorkProduct('picture_frame')).toBe('frame');
  });

  test('maps partial matches (label contains key)', () => {
    expect(matcher._mapPredictionToCorkProduct('leather_wallet_brown')).toBe('wallet');
    expect(matcher._mapPredictionToCorkProduct('wooden_clock_round')).toBe('clock');
  });

  test('maps reverse partial matches (key contains label)', () => {
    // e.g., label "bag" is contained in key "mailbag"
    expect(matcher._mapPredictionToCorkProduct('bag')).toBe('bag');
  });

  test('returns null for unmapped labels', () => {
    expect(matcher._mapPredictionToCorkProduct('airplane')).toBeNull();
    expect(matcher._mapPredictionToCorkProduct('elephant')).toBeNull();
  });

  test('returns null for null/empty', () => {
    expect(matcher._mapPredictionToCorkProduct(null)).toBeNull();
    expect(matcher._mapPredictionToCorkProduct('')).toBeNull();
  });

  test('is case-insensitive', () => {
    expect(matcher._mapPredictionToCorkProduct('NOTEBOOK')).toBe('diary');
    expect(matcher._mapPredictionToCorkProduct('Wallet')).toBe('wallet');
  });
});

// ─── findByHash ─────────────────────────────────────────────────────────────

describe('SmartImageMatcher - findByHash', () => {
  let matcher;

  beforeEach(() => {
    matcher = new SmartImageMatcher({});
    matcher.productIndex = {
      hashes: {
        'abcdef1234567890': 'prod-001',
        'ffffffffffffffff': 'prod-002'
      },
      products: {
        'prod-001': { name: 'Cork Coaster', category: 'coaster', productId: 'prod-001' },
        'prod-002': { name: 'Cork Diary', category: 'diary', productId: 'prod-002' }
      }
    };
  });

  test('returns exact match with high confidence', async () => {
    visionUtils.calculatePHash.mockResolvedValue('abcdef1234567890');
    visionUtils.hammingDistance.mockReturnValue(0);

    const result = await matcher.findByHash(Buffer.from('image'));
    expect(result).not.toBeNull();
    expect(result.productId).toBe('prod-001');
    expect(result.confidence).toBe(0.95);
  });

  test('returns close match with medium confidence', async () => {
    visionUtils.calculatePHash.mockResolvedValue('abcdef1234567899');
    visionUtils.hammingDistance.mockReturnValue(12);

    const result = await matcher.findByHash(Buffer.from('image'));
    expect(result).not.toBeNull();
    expect(result.confidence).toBe(0.75);
  });

  test('returns null when no match within threshold', async () => {
    visionUtils.calculatePHash.mockResolvedValue('0000000000000000');
    visionUtils.hammingDistance.mockReturnValue(30);

    const result = await matcher.findByHash(Buffer.from('image'));
    expect(result).toBeNull();
  });

  test('returns null when pHash calculation fails', async () => {
    visionUtils.calculatePHash.mockResolvedValue(null);

    const result = await matcher.findByHash(Buffer.from('image'));
    expect(result).toBeNull();
  });

  test('sorts matches by distance (closest first)', async () => {
    visionUtils.calculatePHash.mockResolvedValue('test-hash');
    // First hash is closer
    visionUtils.hammingDistance
      .mockReturnValueOnce(5)   // prod-001: close
      .mockReturnValueOnce(12); // prod-002: medium

    const result = await matcher.findByHash(Buffer.from('image'));
    expect(result.productId).toBe('prod-001');
    expect(result.confidence).toBe(0.95);
  });
});

// ─── analyzeVisualFeatures ──────────────────────────────────────────────────

describe('SmartImageMatcher - analyzeVisualFeatures', () => {
  let matcher;

  beforeEach(() => {
    matcher = new SmartImageMatcher({});
  });

  test('returns combined analysis from all vision-utils functions', async () => {
    const mockFeatures = { aspectRatio: 1.0, isCorkColored: { isCork: true }, histogram: {} };
    const mockLogo = { isLikeLogo: false, confidence: 0.1 };
    const mockCenter = { isCorkColored: true };
    const mockCategory = { category: 'coaster', confidence: 0.8 };
    const mockWhiteBg = { isWhiteBg: false, confidence: 0.1 };

    visionUtils.extractImageFeatures.mockResolvedValue(mockFeatures);
    visionUtils.detectLogo.mockResolvedValue(mockLogo);
    visionUtils.extractCenterRegionFeatures.mockResolvedValue(mockCenter);
    visionUtils.matchToCategory.mockReturnValue(mockCategory);
    visionUtils.detectWhiteBackground.mockReturnValue(mockWhiteBg);

    const result = await matcher.analyzeVisualFeatures(Buffer.from('image'));

    expect(result.features).toBe(mockFeatures);
    expect(result.logoDetection).toBe(mockLogo);
    expect(result.category).toBe(mockCategory);
    expect(result.centerFeatures).toBe(mockCenter);
    expect(result.isWhiteBg).toBe(false);
  });

  test('returns null when extractImageFeatures fails', async () => {
    visionUtils.extractImageFeatures.mockResolvedValue(null);
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false });
    visionUtils.extractCenterRegionFeatures.mockResolvedValue(null);

    const result = await matcher.analyzeVisualFeatures(Buffer.from('image'));
    expect(result).toBeNull();
  });
});

// ─── callVisionAPI ──────────────────────────────────────────────────────────

describe('SmartImageMatcher - callVisionAPI', () => {
  let matcher;

  beforeEach(() => {
    matcher = new SmartImageMatcher({ CLARIFAI_API_KEY: 'test-key' });
    axios.mockReset();
  });

  test('calls API and returns formatted result on success', async () => {
    axios.mockResolvedValue({
      data: {
        outputs: [{
          data: {
            concepts: [
              { name: 'cork' }, { name: 'wood' }, { name: 'brown' },
              { name: 'texture' }, { name: 'natural' }
            ]
          }
        }]
      }
    });

    const result = await matcher.callVisionAPI('clarifai', Buffer.from('image'), 'test prompt');
    expect(result.provider).toBe('clarifai');
    expect(result.success).toBe(true);
    expect(result.response).toContain('cork');
    expect(matcher.stats.byProvider.clarifai.success).toBe(1);
  });

  test('tracks failure stats on error', async () => {
    axios.mockRejectedValue(new Error('API timeout'));

    await expect(matcher.callVisionAPI('clarifai', Buffer.from('image'), 'test'))
      .rejects.toThrow('API timeout');
    expect(matcher.stats.byProvider.clarifai.failures).toBe(1);
    expect(matcher.stats.totalFailures).toBe(1);
  });

  test('throws for unknown provider', async () => {
    await expect(matcher.callVisionAPI('nonexistent', Buffer.from('image'), 'test'))
      .rejects.toThrow('Unknown provider');
  });

  test('throws when provider not configured', async () => {
    const emptyMatcher = new SmartImageMatcher({});
    await expect(emptyMatcher.callVisionAPI('clarifai', Buffer.from('image'), 'test'))
      .rejects.toThrow('not configured');
  });
});

// ─── tryAllVisionAPIs ───────────────────────────────────────────────────────

describe('SmartImageMatcher - tryAllVisionAPIs', () => {
  test('tries providers in order, returns first success', async () => {
    const matcher = new SmartImageMatcher({
      CLARIFAI_API_KEY: 'key',
      SAMBANOVA_API_KEY: 'key'
    });

    // Clarifai fails, SambaNova succeeds
    axios
      .mockRejectedValueOnce(new Error('Clarifai down'))
      .mockResolvedValueOnce({
        data: { choices: [{ message: { content: 'This is a cork coaster!' } }] }
      });

    const result = await matcher.tryAllVisionAPIs(Buffer.from('image'), 'prompt');
    expect(result.provider).toBe('sambanova');
    expect(result.success).toBe(true);
  });

  test('throws when no providers configured', async () => {
    const matcher = new SmartImageMatcher({});
    await expect(matcher.tryAllVisionAPIs(Buffer.from('image'), 'prompt'))
      .rejects.toThrow('No vision APIs configured');
  });

  test('throws when all providers fail', async () => {
    const matcher = new SmartImageMatcher({ CLARIFAI_API_KEY: 'key' });
    axios.mockRejectedValue(new Error('fail'));

    await expect(matcher.tryAllVisionAPIs(Buffer.from('image'), 'prompt'))
      .rejects.toThrow('All vision APIs failed');
  });
});

// ─── identifyImage (full 4-layer pipeline) ──────────────────────────────────

describe('SmartImageMatcher - identifyImage', () => {
  let matcher;

  beforeEach(() => {
    matcher = new SmartImageMatcher({});
    // Skip hash index loading
    matcher.hashIndexPromise = Promise.resolve();
    matcher.indexLoaded = true;
    // Skip local ML
    matcher.localMLReady = false;
    matcher.localMLInitPromise = Promise.resolve();

    jest.clearAllMocks();
  });

  test('returns hash match result at Layer 1 when confident', async () => {
    visionUtils.calculatePHash.mockResolvedValue('match-hash');
    visionUtils.hammingDistance.mockReturnValue(3);

    matcher.productIndex = {
      hashes: { 'match-hash': 'prod-001' },
      products: { 'prod-001': { name: 'Cork Coaster', category: 'coaster' } }
    };

    const result = await matcher.identifyImage(Buffer.from('image'), 'test');
    expect(result.finalResult.method).toBe('hash_match');
    expect(result.finalResult.confidence).toBe(0.95);
    expect(result.finalResult.message).toContain('Cork Coaster');
  });

  test('falls through to Layer 2 visual analysis when hash fails', async () => {
    visionUtils.calculatePHash.mockResolvedValue(null);

    const mockFeatures = {
      aspectRatio: 1.0, isCorkColored: { isCork: true },
      isSimple: false, histogram: {}
    };
    visionUtils.extractImageFeatures.mockResolvedValue(mockFeatures);
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0.1 });
    visionUtils.extractCenterRegionFeatures.mockResolvedValue(null);
    visionUtils.matchToCategory.mockReturnValue({ category: 'coaster', confidence: 0.7 });
    visionUtils.detectWhiteBackground.mockReturnValue({ isWhiteBg: false, confidence: 0.1 });

    const result = await matcher.identifyImage(Buffer.from('image'), 'test');
    expect(result.finalResult.method).toBe('visual_category');
    expect(result.finalResult.category).toBe('coaster');
  });

  test('detects logos at Layer 2 (non-white background)', async () => {
    visionUtils.calculatePHash.mockResolvedValue(null);

    visionUtils.extractImageFeatures.mockResolvedValue({
      aspectRatio: 1.0, isCorkColored: { isCork: false },
      isSimple: true, histogram: {}
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: true, confidence: 0.8 });
    visionUtils.extractCenterRegionFeatures.mockResolvedValue(null);
    visionUtils.matchToCategory.mockReturnValue({ category: 'logo', confidence: 0.3 });
    visionUtils.detectWhiteBackground.mockReturnValue({ isWhiteBg: false, confidence: 0.1 });

    const result = await matcher.identifyImage(Buffer.from('image'), 'test');
    expect(result.finalResult.method).toBe('visual_logo');
    expect(result.finalResult.category).toBe('logo');
  });

  test('skips logo detection on white background', async () => {
    visionUtils.calculatePHash.mockResolvedValue(null);

    visionUtils.extractImageFeatures.mockResolvedValue({
      aspectRatio: 1.0, isCorkColored: { isCork: false },
      isSimple: true, histogram: {}
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: true, confidence: 0.8 });
    visionUtils.extractCenterRegionFeatures.mockResolvedValue(null);
    visionUtils.matchToCategory.mockReturnValue({ category: 'unknown', confidence: 0.1 });
    visionUtils.detectWhiteBackground.mockReturnValue({ isWhiteBg: true, confidence: 0.9 });

    const result = await matcher.identifyImage(Buffer.from('image'), 'test');
    // Should NOT be visual_logo because of white background
    expect(result.finalResult.method).not.toBe('visual_logo');
  });

  test('boosts confidence for cork on white background', async () => {
    visionUtils.calculatePHash.mockResolvedValue(null);

    visionUtils.extractImageFeatures.mockResolvedValue({
      aspectRatio: 1.0, isCorkColored: { isCork: false },
      isSimple: false, histogram: {}
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0.1 });
    visionUtils.extractCenterRegionFeatures.mockResolvedValue({ isCorkColored: true });
    // Low base confidence
    visionUtils.matchToCategory.mockReturnValue({ category: 'coaster', confidence: 0.4 });
    visionUtils.detectWhiteBackground.mockReturnValue({ isWhiteBg: true, confidence: 0.9 });

    const result = await matcher.identifyImage(Buffer.from('image'), 'test');
    // Cork center on white bg boosts to 0.8, which passes 0.5 threshold
    expect(result.finalResult.method).toBe('visual_category');
    expect(result.finalResult.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('returns fallback when all layers fail', async () => {
    visionUtils.calculatePHash.mockResolvedValue(null);
    // Return minimal features so Layer 2 produces a result with 'unknown' category
    visionUtils.extractImageFeatures.mockResolvedValue({
      aspectRatio: 1.0, isCorkColored: { isCork: false },
      isSimple: false, histogram: null
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0 });
    visionUtils.extractCenterRegionFeatures.mockResolvedValue(null);
    visionUtils.matchToCategory.mockReturnValue({ category: 'unknown', confidence: 0 });
    visionUtils.detectWhiteBackground.mockReturnValue({ isWhiteBg: false, confidence: 0 });

    const result = await matcher.identifyImage(Buffer.from('image'), 'test');
    expect(result.finalResult.method).toBe('fallback');
    expect(result.finalResult.confidence).toBe(0);
  });
});

// ─── loadIndex / saveIndex ──────────────────────────────────────────────────

describe('SmartImageMatcher - Index Management', () => {
  // Use spyOn for fs.promises (real module) since jest.mock('fs') doesn't
  // work for core modules in Jest 30
  const fsPromises = require('fs').promises;

  test('loadIndex reads from file and sets indexLoaded', async () => {
    const matcher = new SmartImageMatcher({});
    matcher.indexLoaded = false;

    const spy = jest.spyOn(fsPromises, 'readFile').mockResolvedValue(JSON.stringify({
      hashes: { 'abc': 'prod-1' },
      products: { 'prod-1': { name: 'Test' } },
      lastUpdated: '2024-01-01'
    }));

    await matcher.loadIndex();
    expect(matcher.indexLoaded).toBe(true);
    expect(matcher.productIndex.hashes['abc']).toBe('prod-1');
    spy.mockRestore();
  });

  test('loadIndex handles missing file gracefully', async () => {
    const matcher = new SmartImageMatcher({});
    matcher.indexLoaded = false;

    const spy = jest.spyOn(fsPromises, 'readFile').mockRejectedValue(new Error('ENOENT'));

    await matcher.loadIndex();
    expect(matcher.indexLoaded).toBe(true); // Sets loaded = true even on error
    spy.mockRestore();
  });

  test('loadIndex skips when already loaded', async () => {
    const matcher = new SmartImageMatcher({});
    matcher.indexLoaded = true;

    const spy = jest.spyOn(fsPromises, 'readFile');
    await matcher.loadIndex();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('saveIndex writes JSON to disk', async () => {
    const matcher = new SmartImageMatcher({});
    const spy = jest.spyOn(fsPromises, 'writeFile').mockResolvedValue();

    await matcher.saveIndex();
    expect(spy).toHaveBeenCalledWith(
      matcher.indexPath,
      expect.any(String)
    );
    expect(matcher.productIndex.lastUpdated).not.toBeNull();
    spy.mockRestore();
  });
});

// ─── _buildVisionPrompt ─────────────────────────────────────────────────────

describe('SmartImageMatcher - _buildVisionPrompt', () => {
  let matcher;

  beforeEach(() => {
    matcher = new SmartImageMatcher({});
  });

  test('includes user message in prompt', () => {
    const prompt = matcher._buildVisionPrompt('I want cork coasters');
    expect(prompt).toContain('I want cork coasters');
    expect(prompt).toContain('Priya');
    expect(prompt).toContain('coasters');
  });

  test('uses default when no user message', () => {
    const prompt = matcher._buildVisionPrompt('');
    expect(prompt).toContain('(sent image)');
  });
});

// ─── getStats ───────────────────────────────────────────────────────────────

describe('SmartImageMatcher - getStats', () => {
  test('returns complete stats structure', () => {
    const matcher = new SmartImageMatcher({});
    const stats = matcher.getStats();

    expect(stats.productsIndexed).toBeDefined();
    expect(stats.hashesStored).toBeDefined();
    expect(stats.localMLReady).toBe(false);
    expect(stats.configuredProviders).toEqual([]);
    expect(stats.architecture).toBeDefined();
    expect(stats.architecture.layer1).toContain('Hash');
    expect(stats.architecture.layer2).toContain('Visual');
  });
});

// ─── checkAvailableLocalML (static) ─────────────────────────────────────────

describe('SmartImageMatcher - checkAvailableLocalML', () => {
  test('returns results for all ML providers', () => {
    const results = SmartImageMatcher.checkAvailableLocalML();
    expect(results.tensorflow).toBeDefined();
    expect(results.onnx).toBeDefined();
    expect(results.transformers).toBeDefined();
    expect(results.ollama).toBeDefined();
    // Each should have name and available fields
    for (const [, result] of Object.entries(results)) {
      expect(result.name).toBeDefined();
      expect(typeof result.available).toBe('boolean');
    }
  });
});
