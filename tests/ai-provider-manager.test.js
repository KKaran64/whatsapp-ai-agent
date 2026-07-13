const AIProviderManager = require('../ai-provider-manager');

// Mock external dependencies
jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn()
      }
    }
  }));
});

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn()
    }
  }));
});

jest.mock('axios');
const axios = require('axios');

// Suppress console output during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ─── Constructor & Initialization ────────────────────────────────────────────

describe('AIProviderManager - Initialization', () => {
  test('initializes with multiple Groq keys', () => {
    const manager = new AIProviderManager({
      GROQ_API_KEY: 'key1',
      GROQ_API_KEY_2: 'key2',
      GROQ_API_KEY_3: 'key3'
    });
    expect(manager.groqKeys).toHaveLength(3);
    expect(manager.groqClients).toHaveLength(3);
  });

  test('initializes with no Groq keys', () => {
    const manager = new AIProviderManager({});
    expect(manager.groqKeys).toHaveLength(0);
    expect(manager.groqClients).toHaveLength(0);
  });

  test('initializes Gemini keys dynamically', () => {
    const config = { GEMINI_API_KEY: 'gem1' };
    for (let i = 2; i <= 5; i++) config[`GEMINI_API_KEY_${i}`] = `gem${i}`;
    const manager = new AIProviderManager(config);
    expect(manager.geminiKeys).toHaveLength(5);
  });

  test('initializes Claude when key provided', () => {
    const manager = new AIProviderManager({ ANTHROPIC_API_KEY: 'claude-key' });
    expect(manager.anthropic).not.toBeNull();
  });

  test('sets Claude to null when no key', () => {
    const manager = new AIProviderManager({});
    expect(manager.anthropic).toBeNull();
  });

  test('initializes stats object', () => {
    const manager = new AIProviderManager({});
    expect(manager.stats).toEqual({
      groq: { success: 0, failures: 0, lastFailure: null, keyRotations: 0 },
      gemini: { success: 0, failures: 0, lastFailure: null, keyRotations: 0 },
      claude: { success: 0, failures: 0, lastFailure: null },
      fallback: { success: 0 }
    });
  });

  test('initializes empty response cache', () => {
    const manager = new AIProviderManager({});
    expect(manager.responseCache.size).toBe(0);
  });
});

// ─── getNextGroqClient (round-robin) ─────────────────────────────────────────

describe('AIProviderManager - Groq Key Rotation', () => {
  test('rotates through Groq clients in round-robin', () => {
    const manager = new AIProviderManager({
      GROQ_API_KEY: 'key1',
      GROQ_API_KEY_2: 'key2',
      GROQ_API_KEY_3: 'key3'
    });

    const first = manager.getNextGroqClient();
    const second = manager.getNextGroqClient();
    const third = manager.getNextGroqClient();
    const fourth = manager.getNextGroqClient(); // wraps around

    expect(first).toBe(manager.groqClients[0]);
    expect(second).toBe(manager.groqClients[1]);
    expect(third).toBe(manager.groqClients[2]);
    expect(fourth).toBe(manager.groqClients[0]);
  });

  test('returns null when no Groq clients', () => {
    const manager = new AIProviderManager({});
    expect(manager.getNextGroqClient()).toBeNull();
  });

  test('tracks key rotations in stats', () => {
    const manager = new AIProviderManager({
      GROQ_API_KEY: 'key1',
      GROQ_API_KEY_2: 'key2'
    });

    // Cycle through all keys to trigger rotation count
    manager.getNextGroqClient(); // key1
    manager.getNextGroqClient(); // key2 → rotation++
    manager.getNextGroqClient(); // key1
    manager.getNextGroqClient(); // key2 → rotation++

    expect(manager.stats.groq.keyRotations).toBeGreaterThanOrEqual(1);
  });
});

// ─── getCacheKey ─────────────────────────────────────────────────────────────

describe('AIProviderManager - Cache Key Generation', () => {
  let manager;
  beforeEach(() => { manager = new AIProviderManager({}); });

  test('generates consistent hash for same input', () => {
    const key1 = manager.getCacheKey('hello', 'user1');
    const key2 = manager.getCacheKey('hello', 'user1');
    expect(key1).toBe(key2);
  });

  test('generates different hashes for different messages', () => {
    const key1 = manager.getCacheKey('hello', 'user1');
    const key2 = manager.getCacheKey('world', 'user1');
    expect(key1).not.toBe(key2);
  });

  test('generates different hashes for different users', () => {
    const key1 = manager.getCacheKey('hello', 'user1');
    const key2 = manager.getCacheKey('hello', 'user2');
    expect(key1).not.toBe(key2);
  });

  test('is case-insensitive', () => {
    const key1 = manager.getCacheKey('Hello', 'user1');
    const key2 = manager.getCacheKey('hello', 'user1');
    expect(key1).toBe(key2);
  });

  test('trims whitespace before hashing', () => {
    const key1 = manager.getCacheKey('  hello  ', 'user1');
    const key2 = manager.getCacheKey('hello', 'user1');
    expect(key1).toBe(key2);
  });

  test('returns 32-character hex string', () => {
    const key = manager.getCacheKey('test message');
    expect(key).toHaveLength(32);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
  });
});

// ─── isValidResponse ─────────────────────────────────────────────────────────

describe('AIProviderManager - Response Validation', () => {
  let manager;
  beforeEach(() => { manager = new AIProviderManager({}); });

  test('accepts normal text responses', () => {
    expect(manager.isValidResponse('Hello! How can I help you?')).toBe(true);
    expect(manager.isValidResponse('Our cork coasters cost Rs 150 each.')).toBe(true);
  });

  test('rejects null/undefined/empty', () => {
    expect(manager.isValidResponse(null)).toBe(false);
    expect(manager.isValidResponse(undefined)).toBe(false);
    expect(manager.isValidResponse('')).toBe(false);
  });

  test('rejects non-string', () => {
    expect(manager.isValidResponse(123)).toBe(false);
    expect(manager.isValidResponse({})).toBe(false);
  });

  test('rejects script tags', () => {
    expect(manager.isValidResponse('Hello <script>alert(1)</script>')).toBe(false);
  });

  test('rejects javascript: protocol', () => {
    expect(manager.isValidResponse('Click javascript:void(0)')).toBe(false);
  });

  test('rejects event handlers', () => {
    expect(manager.isValidResponse('Image onerror=alert(1)')).toBe(false);
    expect(manager.isValidResponse('Button onclick=steal()')).toBe(false);
  });

  test('rejects eval calls', () => {
    expect(manager.isValidResponse('Use eval(code) here')).toBe(false);
  });

  test('rejects document.cookie', () => {
    expect(manager.isValidResponse('Access document.cookie now')).toBe(false);
  });

  test('rejects iframe', () => {
    expect(manager.isValidResponse('Load <iframe>content</iframe>')).toBe(false);
  });

  test('rejects MongoDB operator', () => {
    expect(manager.isValidResponse('Query with $where 1==1')).toBe(false);
  });
});

// ─── checkCache ──────────────────────────────────────────────────────────────

describe('AIProviderManager - Cache Behavior', () => {
  let manager;
  beforeEach(() => { manager = new AIProviderManager({}); });

  test('returns cached greeting for exact "hi"', () => {
    const result = manager.checkCache('hi');
    expect(result).toContain('Sita');
    expect(result).toContain('9 Cork');
  });

  test('returns cached greeting for exact "hello"', () => {
    const result = manager.checkCache('hello');
    expect(result).toContain('Sita');
  });

  test('returns cached greeting for exact "hey"', () => {
    const result = manager.checkCache('hey');
    expect(result).toContain('Sita');
  });

  test('does NOT cache greetings with additional text', () => {
    expect(manager.checkCache('hi do you have coasters')).toBeNull();
    expect(manager.checkCache('hello I want to buy')).toBeNull();
  });

  test('returns null for unknown messages', () => {
    expect(manager.checkCache('what products do you have?')).toBeNull();
    expect(manager.checkCache('show me cork coasters')).toBeNull();
  });

  // The generic per-message response cache was removed (it ignored
  // conversation context, so repeated short messages like "yes" replayed
  // stale replies). checkCache must now ONLY serve exact greetings.
  test('does NOT serve previously stored responses (context-blind cache removed)', () => {
    manager.cacheResponse('test query', 'test response', 'user123');
    expect(manager.checkCache('test query', 'user123')).toBeNull();
  });

  test('ignores entries planted in responseCache (generic lookup removed)', () => {
    const cacheKey = manager.getCacheKey('test msg', null);
    manager.responseCache.set(cacheKey, {
      response: 'old response',
      timestamp: Date.now()
    });

    expect(manager.checkCache('test msg')).toBeNull();
  });
});

// ─── cacheResponse ───────────────────────────────────────────────────────────

describe('AIProviderManager - Cache Storage', () => {
  let manager;
  beforeEach(() => { manager = new AIProviderManager({}); });

  test('stores valid responses', () => {
    const result = manager.cacheResponse('question', 'safe answer');
    expect(result).toBe(true);
    expect(manager.responseCache.size).toBe(1);
  });

  test('refuses to cache suspicious responses', () => {
    const result = manager.cacheResponse('question', '<script>bad</script>');
    expect(result).toBe(false);
    expect(manager.responseCache.size).toBe(0);
  });

  test('evicts oldest entry when cache exceeds 1000', () => {
    // Fill cache to 1000
    for (let i = 0; i < 1001; i++) {
      manager.responseCache.set(`key-${i}`, { response: `resp-${i}`, timestamp: Date.now() });
    }
    expect(manager.responseCache.size).toBe(1001);

    // Adding one more should evict the first
    manager.cacheResponse('new question', 'new answer');
    expect(manager.responseCache.size).toBe(1001); // evicted one, added one
  });
});

// ─── tryGroq ─────────────────────────────────────────────────────────────────

describe('AIProviderManager - tryGroq', () => {
  test('returns response on success', async () => {
    const manager = new AIProviderManager({ GROQ_API_KEY: 'key1' });
    const mockResponse = { choices: [{ message: { content: 'Hello from Groq!' } }] };
    manager.groqClients[0].chat.completions.create.mockResolvedValue(mockResponse);

    const result = await manager.tryGroq('system', [], 'hello');
    expect(result.provider).toBe('groq');
    expect(result.response).toBe('Hello from Groq!');
    expect(manager.stats.groq.success).toBe(1);
  });

  test('rotates to next key on rate limit', async () => {
    const manager = new AIProviderManager({
      GROQ_API_KEY: 'key1',
      GROQ_API_KEY_2: 'key2'
    });

    // First key rate limited
    manager.groqClients[0].chat.completions.create.mockRejectedValue(
      Object.assign(new Error('rate_limit'), { response: { status: 429 } })
    );
    // Second key succeeds
    manager.groqClients[1].chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'Fallback response' } }]
    });

    const result = await manager.tryGroq('system', [], 'hello');
    expect(result.response).toBe('Fallback response');
  });

  test('throws RATE_LIMIT when all keys exhausted', async () => {
    const manager = new AIProviderManager({
      GROQ_API_KEY: 'key1',
      GROQ_API_KEY_2: 'key2'
    });

    const rateLimitError = Object.assign(new Error('rate_limit'), { response: { status: 429 } });
    manager.groqClients[0].chat.completions.create.mockRejectedValue(rateLimitError);
    manager.groqClients[1].chat.completions.create.mockRejectedValue(rateLimitError);

    await expect(manager.tryGroq('system', [], 'hello')).rejects.toThrow('RATE_LIMIT');
    expect(manager.stats.groq.failures).toBe(1);
  });

  test('throws immediately on non-rate-limit error', async () => {
    const manager = new AIProviderManager({ GROQ_API_KEY: 'key1' });
    manager.groqClients[0].chat.completions.create.mockRejectedValue(new Error('Auth failed'));

    await expect(manager.tryGroq('system', [], 'hello')).rejects.toThrow('Auth failed');
    expect(manager.stats.groq.failures).toBe(1);
  });

  test('throws when no Groq keys configured', async () => {
    const manager = new AIProviderManager({});
    await expect(manager.tryGroq('system', [], 'hello')).rejects.toThrow('No Groq API keys configured');
  });
});

// ─── tryGemini ───────────────────────────────────────────────────────────────

describe('AIProviderManager - tryGemini', () => {
  test('returns response on success', async () => {
    const manager = new AIProviderManager({ GEMINI_API_KEY: 'gem1' });
    axios.post.mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: 'Hello from Gemini!' }] } }] }
    });

    const result = await manager.tryGemini('system', [], 'hello');
    expect(result.provider).toBe('gemini');
    expect(result.response).toBe('Hello from Gemini!');
    expect(manager.stats.gemini.success).toBe(1);
  });

  test('rotates keys on rate limit', async () => {
    const manager = new AIProviderManager({
      GEMINI_API_KEY: 'gem1',
      GEMINI_API_KEY_2: 'gem2'
    });

    axios.post
      .mockRejectedValueOnce({ response: { status: 429 }, message: 'rate limit' })
      .mockResolvedValueOnce({
        data: { candidates: [{ content: { parts: [{ text: 'From key2' }] } }] }
      });

    const result = await manager.tryGemini('system', [], 'hello');
    expect(result.response).toBe('From key2');
  });

  test('throws RATE_LIMIT when all keys exhausted', async () => {
    const manager = new AIProviderManager({
      GEMINI_API_KEY: 'gem1',
      GEMINI_API_KEY_2: 'gem2'
    });

    axios.post.mockRejectedValue({ response: { status: 429 }, message: 'rate limit' });

    await expect(manager.tryGemini('system', [], 'hello')).rejects.toThrow('RATE_LIMIT');
  });

  test('throws when no Gemini keys configured', async () => {
    const manager = new AIProviderManager({});
    await expect(manager.tryGemini('system', [], 'hello')).rejects.toThrow('No Gemini API keys configured');
  });

  it('uses stable gemini model, not experimental', async () => {
    const manager = new AIProviderManager({ GEMINI_API_KEY: 'test-key' });
    axios.post.mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
    });
    await manager.tryGemini('sys', [], 'hello');
    const url = axios.post.mock.calls[0]?.[0] || '';
    expect(url).not.toContain('-exp');
    expect(url).toContain('gemini');
  });
});

// ─── tryClaude ───────────────────────────────────────────────────────────────

describe('AIProviderManager - tryClaude', () => {
  test('returns response on success', async () => {
    const manager = new AIProviderManager({ ANTHROPIC_API_KEY: 'claude-key' });
    manager.anthropic.messages.create.mockResolvedValue({
      content: [{ text: 'Hello from Claude!' }]
    });

    const result = await manager.tryClaude('system', [], 'hello');
    expect(result.provider).toBe('claude');
    expect(result.response).toBe('Hello from Claude!');
    expect(manager.stats.claude.success).toBe(1);
  });

  test('throws when API key not configured', async () => {
    const manager = new AIProviderManager({});
    await expect(manager.tryClaude('system', [], 'hello')).rejects.toThrow('Claude API key not configured');
  });

  test('records failure stats on error', async () => {
    const manager = new AIProviderManager({ ANTHROPIC_API_KEY: 'claude-key' });
    manager.anthropic.messages.create.mockRejectedValue(new Error('API error'));

    await expect(manager.tryClaude('system', [], 'hello')).rejects.toThrow('API error');
    expect(manager.stats.claude.failures).toBe(1);
    expect(manager.stats.claude.lastFailure).toBeInstanceOf(Date);
  });
});

// ─── getFallbackResponse ─────────────────────────────────────────────────────

describe('AIProviderManager - Fallback Responses', () => {
  let manager;
  beforeEach(() => { manager = new AIProviderManager({}); });

  test('responds to cork material questions', () => {
    const response = manager.getFallbackResponse('what is cork?');
    expect(response).toContain('Cork');
    expect(response).toContain('tree');
  });

  test('responds to sustainability questions', () => {
    const response = manager.getFallbackResponse('is this eco-friendly?');
    expect(response).toContain('cork');
  });

  test('responds to exact greeting "hi"', () => {
    const response = manager.getFallbackResponse('hi');
    expect(response).toContain('9 Cork');
  });

  test('responds to contact questions', () => {
    const response = manager.getFallbackResponse('what is your email?');
    expect(response).toContain('info@9cork.com');
  });

  test('returns generic error for product queries (needs AI context)', () => {
    const response = manager.getFallbackResponse('show me cork coasters for corporate gifting');
    expect(response).toContain('trouble processing');
  });
});

// ─── getResponse (full fallback chain) ───────────────────────────────────────

describe('AIProviderManager - getResponse Full Chain', () => {
  test('returns cached response first', async () => {
    const manager = new AIProviderManager({ GROQ_API_KEY: 'key1' });

    const result = await manager.getResponse('system', [], 'hi');
    expect(result.provider).toBe('cache');
    expect(result.response).toContain('Sita');
  });

  test('falls back from Groq to Gemini', async () => {
    const manager = new AIProviderManager({
      GROQ_API_KEY: 'key1',
      GEMINI_API_KEY: 'gem1'
    });

    manager.groqClients[0].chat.completions.create.mockRejectedValue(new Error('Groq down'));
    axios.post.mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: 'Gemini response' }] } }] }
    });

    const result = await manager.getResponse('system', [], 'tell me about products');
    expect(result.provider).toBe('gemini');
    expect(result.response).toBe('Gemini response');
  });

  test('falls back to rule-based when all providers fail', async () => {
    const manager = new AIProviderManager({
      GROQ_API_KEY: 'key1',
      GEMINI_API_KEY: 'gem1'
    });

    manager.groqClients[0].chat.completions.create.mockRejectedValue(new Error('fail'));
    axios.post.mockRejectedValue(new Error('fail'));

    // Use a non-greeting, non-keyword message so it falls through to generic fallback
    const result = await manager.getResponse('system', [], 'how much for 50 coasters with custom print?');
    expect(result.provider).toBe('fallback');
    expect(result.response).toContain('trouble processing');
  });
});

// ─── getStats ────────────────────────────────────────────────────────────────

describe('AIProviderManager - Statistics', () => {
  test('returns accurate statistics', () => {
    const manager = new AIProviderManager({});
    manager.stats.groq.success = 10;
    manager.stats.gemini.success = 5;
    manager.stats.claude.failures = 2;

    const stats = manager.getStats();
    expect(stats.providers).toBe(manager.stats);
    expect(stats.cacheSize).toBe(0);
    expect(stats.totalRequests).toBe(17);
  });
});

// ─── cache userId isolation through getResponse call chain ─────────────────

describe('cache userId isolation through getResponse call chain', () => {
  it('does NOT cache provider responses (context-blind cache removed)', async () => {
    const manager = new AIProviderManager({ GROQ_API_KEY: 'test-key' });
    const cacheSpy = jest.spyOn(manager, 'cacheResponse');

    // Mock the Groq client call
    const groqSpy = jest.spyOn(manager.groqClients[0].chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: 'mocked groq response' } }]
    });

    await manager.tryGroq('sys', [], 'hello world', 'userPhone123');

    expect(cacheSpy).not.toHaveBeenCalled();
    cacheSpy.mockRestore();
    groqSpy.mockRestore();
  });

  it('getResponse calls checkCache with userId', async () => {
    const manager = new AIProviderManager({});
    const checkSpy = jest.spyOn(manager, 'checkCache').mockReturnValue(null);

    await manager.getResponse('sys', [], 'price question', 'userB').catch(() => {});

    expect(checkSpy).toHaveBeenCalledWith('price question', 'userB');
    checkSpy.mockRestore();
  });
});
