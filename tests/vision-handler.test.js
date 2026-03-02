const VisionHandler = require('../vision-handler');

// Mock all external dependencies
jest.mock('axios');
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}));

// Mock vision-utils (sharp dependency)
jest.mock('../vision-utils', () => ({
  compressImage: jest.fn(async (buf) => ({ buffer: buf, compressed: false })),
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
  })
}));

// Mock SmartImageMatcher
jest.mock('../smart-image-matcher', () => {
  return jest.fn().mockImplementation(() => ({
    configuredProviders: [],
    identifyImage: jest.fn(),
    getStats: jest.fn(() => ({ productsIndexed: 0 }))
  }));
});

const axios = require('axios');
const fs = require('fs');
const visionUtils = require('../vision-utils');
const SmartImageMatcher = require('../smart-image-matcher');

// Suppress console noise
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

function createHandler(overrides = {}) {
  const handler = new VisionHandler({
    WHATSAPP_TOKEN: 'test-token',
    ...overrides
  });
  // Stop the stats save interval to prevent timers leaking
  if (handler._statsSaveInterval) {
    clearInterval(handler._statsSaveInterval);
  }
  return handler;
}

// ─── Constructor ────────────────────────────────────────────────────────────

describe('VisionHandler - Constructor', () => {
  test('initializes in local-only mode with no API keys', () => {
    const handler = createHandler();
    expect(handler.localOnlyMode).toBe(true);
    expect(handler.whatsappToken).toBe('test-token');
  });

  test('initializes in hybrid mode with API keys', () => {
    SmartImageMatcher.mockImplementation(() => ({
      configuredProviders: [{ id: 'clarifai', name: 'Clarifai' }],
      identifyImage: jest.fn(),
      getStats: jest.fn(() => ({}))
    }));

    const handler = createHandler({ CLARIFAI_API_KEY: 'key' });
    expect(handler.localOnlyMode).toBe(false);
    expect(handler.hasAnyApiKeys).toBe(true);

    // Restore default mock
    SmartImageMatcher.mockImplementation(() => ({
      configuredProviders: [],
      identifyImage: jest.fn(),
      getStats: jest.fn(() => ({ productsIndexed: 0 }))
    }));
  });

  test('parses comma-separated Gemini keys', () => {
    const handler = createHandler({ GEMINI_API_KEY: 'key1,key2,key3' });
    expect(handler.geminiApiKeys).toEqual(['key1', 'key2', 'key3']);
  });

  test('initializes stats with default values', () => {
    const handler = createHandler();
    expect(handler.stats.totalImages).toBe(0);
    expect(handler.stats.providers.local.success).toBe(0);
    expect(handler.stats.providers.smartMatcher.failures).toBe(0);
  });
});

// ─── downloadImage ──────────────────────────────────────────────────────────

describe('VisionHandler - downloadImage', () => {
  test('downloads and returns image data', async () => {
    const handler = createHandler();
    const imageBytes = Buffer.from('fake-image-data');

    axios.get
      .mockResolvedValueOnce({
        data: { url: 'https://cdn.whatsapp.com/image.jpg', mime_type: 'image/jpeg' }
      })
      .mockResolvedValueOnce({
        data: imageBytes
      });

    const result = await handler.downloadImage('media-123');
    expect(result.base64).toBeDefined();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeKB).toBeDefined();

    // Verify WhatsApp API call
    expect(axios.get).toHaveBeenCalledWith(
      'https://graph.facebook.com/v18.0/media-123',
      { headers: { 'Authorization': 'Bearer test-token' } }
    );
  });

  test('defaults to image/jpeg when mime_type missing', async () => {
    const handler = createHandler();

    axios.get
      .mockResolvedValueOnce({ data: { url: 'https://cdn.whatsapp.com/img' } })
      .mockResolvedValueOnce({ data: Buffer.from('data') });

    const result = await handler.downloadImage('media-456');
    expect(result.mimeType).toBe('image/jpeg');
  });
});

// ─── _buildPrompt ───────────────────────────────────────────────────────────

describe('VisionHandler - _buildPrompt', () => {
  let handler;

  beforeEach(() => {
    handler = createHandler();
  });

  test('includes system context and product categories', () => {
    const prompt = handler._buildPrompt([], 'test message');
    expect(prompt).toContain('Priya');
    expect(prompt).toContain('Coasters');
    expect(prompt).toContain('Diaries');
    expect(prompt).toContain('test message');
  });

  test('includes last 3 conversation messages', () => {
    const history = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
      { role: 'assistant', content: 'fourth' }
    ];
    const prompt = handler._buildPrompt(history, 'new msg');
    // Should include last 3 only
    expect(prompt).toContain('second');
    expect(prompt).toContain('third');
    expect(prompt).toContain('fourth');
    expect(prompt).not.toContain('first');
  });

  test('handles null/empty conversation history', () => {
    const prompt1 = handler._buildPrompt(null, 'test');
    expect(prompt1).toContain('Priya');

    const prompt2 = handler._buildPrompt([], '');
    expect(prompt2).toContain('(sent image)');
  });
});

// ─── _performLocalAnalysis ──────────────────────────────────────────────────

describe('VisionHandler - _performLocalAnalysis', () => {
  let handler;

  beforeEach(() => {
    handler = createHandler();
  });

  test('returns logo result when logo detected with high confidence', async () => {
    visionUtils.extractImageFeatures.mockResolvedValue({ isCorkColored: { isCork: false } });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: true, confidence: 0.7 });
    visionUtils.matchToCategory.mockReturnValue({ category: 'unknown', confidence: 0 });

    const result = await handler._performLocalAnalysis(Buffer.from('image'));
    expect(result.type).toBe('logo');
    expect(result.response).toContain('logo');
  });

  test('returns product result when cork-colored and high category confidence', async () => {
    visionUtils.extractImageFeatures.mockResolvedValue({
      isCorkColored: { isCork: true, confidence: 0.8 }
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0.1 });
    visionUtils.matchToCategory.mockReturnValue({ category: 'coaster', confidence: 0.6 });

    const result = await handler._performLocalAnalysis(Buffer.from('image'));
    expect(result.type).toBe('product');
    expect(result.detectedCategory).toBe('coaster');
    expect(result.response).toContain('coaster');
  });

  test('returns cork_unknown when cork-colored but low category confidence', async () => {
    visionUtils.extractImageFeatures.mockResolvedValue({
      isCorkColored: { isCork: true, confidence: 0.6 }
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0.1 });
    visionUtils.matchToCategory.mockReturnValue({ category: 'unknown', confidence: 0.2 });

    const result = await handler._performLocalAnalysis(Buffer.from('image'));
    expect(result.type).toBe('cork_unknown');
    expect(result.response).toContain('cork product');
  });

  test('returns reference result when no cork detected', async () => {
    visionUtils.extractImageFeatures.mockResolvedValue({
      isCorkColored: { isCork: false }
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0.1 });
    visionUtils.matchToCategory.mockReturnValue({ category: 'unknown', confidence: 0.1 });

    const result = await handler._performLocalAnalysis(Buffer.from('image'));
    expect(result.type).toBe('reference');
    expect(result.response).toContain('reference image');
  });

  test('returns null when feature extraction fails', async () => {
    visionUtils.extractImageFeatures.mockResolvedValue(null);
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false });

    const result = await handler._performLocalAnalysis(Buffer.from('image'));
    expect(result).toBeNull();
  });
});

// ─── _recordLatency ─────────────────────────────────────────────────────────

describe('VisionHandler - _recordLatency', () => {
  test('records success latency for provider', () => {
    const handler = createHandler();
    handler._recordLatency('local', 150, true, 'product');

    expect(handler.stats.providers.local.success).toBe(1);
    expect(handler.stats.providers.local.avgLatencyMs).toBe(150);
    expect(handler.stats.latency.min).toBe(150);
    expect(handler.stats.latency.max).toBe(150);
    expect(handler.stats.totalImages).toBe(1);
    expect(handler.stats.byType.product).toBe(1);
  });

  test('records failure without updating latency averages', () => {
    const handler = createHandler();
    handler._recordLatency('local', 5000, false);

    expect(handler.stats.providers.local.failures).toBe(1);
    expect(handler.stats.providers.local.success).toBe(0);
    expect(handler.stats.providers.local.avgLatencyMs).toBe(0);
  });

  test('tracks min/max latency across multiple calls', () => {
    const handler = createHandler();
    handler._recordLatency('local', 100, true, 'product');
    handler._recordLatency('local', 300, true, 'product');
    handler._recordLatency('local', 50, true, 'logo');

    expect(handler.stats.latency.min).toBe(50);
    expect(handler.stats.latency.max).toBe(300);
    expect(handler.stats.latency.avg).toBe(150); // (100+300+50)/3
  });

  test('keeps only last 20 recent images', () => {
    const handler = createHandler();
    for (let i = 0; i < 25; i++) {
      handler._recordLatency('local', 100, true, 'product');
    }
    expect(handler.stats.recentImages).toHaveLength(20);
  });

  test('ignores unknown provider', () => {
    const handler = createHandler();
    // Should not throw
    handler._recordLatency('nonexistent', 100, true);
    expect(handler.stats.totalImages).toBe(0);
  });
});

// ─── handleImageMessage (full flow) ─────────────────────────────────────────

describe('VisionHandler - handleImageMessage', () => {
  let handler;

  beforeEach(() => {
    handler = createHandler();
    axios.get.mockReset();
    axios.mockReset();

    // Set up download mock
    axios.get
      .mockResolvedValueOnce({
        data: { url: 'https://cdn.whatsapp.com/image.jpg', mime_type: 'image/jpeg' }
      })
      .mockResolvedValueOnce({
        data: Buffer.from('fake-image')
      });
  });

  test('returns smart matcher result when confident', async () => {
    handler.localOnlyMode = false;
    handler.smartMatcher.identifyImage.mockResolvedValue({
      finalResult: {
        method: 'hash_match',
        confidence: 0.95,
        category: 'coaster',
        message: 'This is a Cork Coaster!'
      }
    });

    const result = await handler.handleImageMessage('media-1', 'what is this?', '123', [], '');
    expect(result.provider).toBe('smart-hash_match');
    expect(result.response).toBe('This is a Cork Coaster!');
    expect(result.imageProcessed).toBe(true);
  });

  test('falls through to local analysis in local-only mode', async () => {
    handler.localOnlyMode = true;
    handler.smartMatcher.identifyImage.mockResolvedValue({ finalResult: null });

    visionUtils.extractImageFeatures.mockResolvedValue({
      isCorkColored: { isCork: false }
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0 });
    visionUtils.matchToCategory.mockReturnValue({ category: 'unknown', confidence: 0 });

    const result = await handler.handleImageMessage('media-2', '', '123', [], '');
    expect(result.provider).toBe('local-analyzer');
    expect(result.imageProcessed).toBe(true);
  });

  test('returns local analysis when confidence >= 0.6', async () => {
    handler.localOnlyMode = false;
    handler.smartMatcher.identifyImage.mockResolvedValue({
      finalResult: { confidence: 0.3 } // Too low
    });

    visionUtils.extractImageFeatures.mockResolvedValue({
      isCorkColored: { isCork: true, confidence: 0.8 }
    });
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false, confidence: 0 });
    visionUtils.matchToCategory.mockReturnValue({ category: 'coaster', confidence: 0.8 });

    const result = await handler.handleImageMessage('media-3', '', '123', [], '');
    expect(result.provider).toBe('local-analyzer');
  });

  test('returns fallback when download fails', async () => {
    axios.get.mockReset();
    axios.get.mockRejectedValue(new Error('Network error'));

    const result = await handler.handleImageMessage('media-bad', '', '123', [], '');
    expect(result.provider).toBe('fallback');
    expect(result.imageProcessed).toBe(false);
    expect(result.response).toContain('reference image');
  });

  test('returns fallback when smart matcher throws', async () => {
    handler.localOnlyMode = false;
    handler.smartMatcher.identifyImage.mockRejectedValue(new Error('Matcher exploded'));

    visionUtils.extractImageFeatures.mockResolvedValue(null);
    visionUtils.detectLogo.mockResolvedValue({ isLikeLogo: false });
    visionUtils.matchToCategory.mockReturnValue({ category: 'unknown', confidence: 0 });

    const result = await handler.handleImageMessage('media-4', '', '123', [], '');
    // Falls through to local, then to legacy, then to fallback
    expect(result.imageProcessed).toBe(true);
  });
});

// ─── getStats ───────────────────────────────────────────────────────────────

describe('VisionHandler - getStats', () => {
  test('returns stats with success rate calculation', () => {
    const handler = createHandler();
    handler.stats.providers.local.success = 8;
    handler.stats.providers.local.failures = 2;

    const stats = handler.getStats();
    expect(stats.summary.successRate).toBe('80.0%');
    expect(stats.summary.totalImages).toBe(0); // totalImages is separate counter
  });

  test('returns 0% success rate when no requests', () => {
    const handler = createHandler();
    const stats = handler.getStats();
    expect(stats.summary.successRate).toBe('0%');
  });
});

// ─── shutdown ───────────────────────────────────────────────────────────────

describe('VisionHandler - shutdown', () => {
  test('clears interval and saves stats', () => {
    const handler = new VisionHandler({ WHATSAPP_TOKEN: 'test' });
    expect(handler._statsSaveInterval).toBeDefined();

    handler.shutdown();
    // Verify stats save was attempted (writeFileSync was called)
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});

// ─── _getFallbackResponse ───────────────────────────────────────────────────

describe('VisionHandler - _getFallbackResponse', () => {
  test('returns helpful fallback message', () => {
    const handler = createHandler();
    const response = handler._getFallbackResponse();
    expect(response).toContain('reference image');
    expect(response).toContain('design');
  });
});
