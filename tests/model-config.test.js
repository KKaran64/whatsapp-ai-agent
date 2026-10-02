const fs = require('fs');
const path = require('path');
const { MODELS, TOKEN_BUDGETS, reasoningParams, supportsReasoningEffort, collectGroqKeys } = require('../config/models');

const CALL_SITES = [
  'ai-provider-manager.js',
  'optimized-bot/router-agent.js',
  'optimized-bot/responder-agent.js',
  'pricing/groq-client.js',
  'rag/classifier.js',
  'scripts/weekly-cron.js',
  'pricing/vision-identifier.js',
  'audio-handler.js',
];
// Any literal that looks like a model id. compound/llama are retired; the
// others must come from config/models.js, never be typed at a call site.
const MODEL_ID_RE = /['"`](groq\/compound[^'"`]*|llama-[^'"`]+|openai\/gpt-oss[^'"`]*|qwen\/[^'"`]+|gemini-[0-9][^'"`]*|claude-[^'"`]+)['"`]/;

describe('config/models', () => {
  test('exports every model slot as a non-empty string', () => {
    for (const k of ['GROQ_CHAT', 'GROQ_FAST', 'GROQ_JSON', 'GEMINI_CHAT', 'GEMINI_VISION', 'GEMINI_VISION_LITE', 'GROQ_WHISPER', 'CLAUDE_FALLBACK']) {
      expect(typeof MODELS[k]).toBe('string');
      expect(MODELS[k].length).toBeGreaterThan(3);
    }
  });

  test('no retired model id anywhere in config', () => {
    for (const v of Object.values(MODELS)) {
      expect(v).not.toMatch(/compound|llama-3/);
    }
  });

  test('token budgets leave room for reasoning models', () => {
    expect(TOKEN_BUDGETS.ROUTER).toBeGreaterThanOrEqual(150);
    expect(TOKEN_BUDGETS.RESPONDER).toBeGreaterThanOrEqual(400);
    expect(TOKEN_BUDGETS.CHAT).toBeGreaterThanOrEqual(800);
  });

  test('reasoning_effort is sent only to models that accept it', () => {
    expect(reasoningParams('openai/gpt-oss-120b')).toEqual({ reasoning_effort: 'low' });
    expect(reasoningParams('qwen/qwen3.8-27b')).toEqual({});
    expect(reasoningParams('some/unknown-model')).toEqual({});
    expect(supportsReasoningEffort('openai/gpt-oss-20b')).toBe(true);
  });

  test('env overrides win', () => {
    jest.resetModules();
    process.env.GROQ_MODEL_CHAT = 'override/model';
    const fresh = require('../config/models');
    expect(fresh.MODELS.GROQ_CHAT).toBe('override/model');
    delete process.env.GROQ_MODEL_CHAT;
    jest.resetModules();
  });

  test.each(CALL_SITES)('%s has no hardcoded model id', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(MODEL_ID_RE);
  });

  describe('collectGroqKeys', () => {
    test('collects GROQ_API_KEY alone', () => {
      expect(collectGroqKeys({ GROQ_API_KEY: 'k1' })).toEqual(['k1']);
    });

    test('collects GROQ_API_KEY through GROQ_API_KEY_10', () => {
      const config = { GROQ_API_KEY: 'k1' };
      for (let i = 2; i <= 10; i++) config[`GROQ_API_KEY_${i}`] = `k${i}`;
      expect(collectGroqKeys(config)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10']);
    });

    test('ignores GROQ_API_KEY_11 and beyond', () => {
      const config = { GROQ_API_KEY: 'k1', GROQ_API_KEY_11: 'k11' };
      expect(collectGroqKeys(config)).toEqual(['k1']);
    });

    test('returns empty array when no keys configured', () => {
      expect(collectGroqKeys({})).toEqual([]);
    });

    test('skips gaps (e.g. no GROQ_API_KEY_2 but a GROQ_API_KEY_3)', () => {
      expect(collectGroqKeys({ GROQ_API_KEY: 'k1', GROQ_API_KEY_3: 'k3' })).toEqual(['k1', 'k3']);
    });
  });
});
