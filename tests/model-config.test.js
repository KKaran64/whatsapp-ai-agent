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
// Must also catch an id embedded in a URL (e.g. a Gemini REST endpoint
// string that bakes in the model instead of reading config/models.js), so
// this does not require a quote immediately before the id — only that the
// id isn't itself part of a longer identifier/path segment.
// NOTE on deviation from the brief: the brief's regex excludes `/` from the
// pre-match boundary (`[^\w\/.-]`), which means a URL-embedded id — the
// exact case the self-test below requires — can never match, since a URL
// id is always preceded by `/` (".../models/gemini-2.5-flash"). Dropping
// `/` from that excluded set (so a preceding slash counts as a boundary,
// just like a space or quote) is the smallest change that makes the
// self-test pass while still refusing to match an id embedded inside a
// longer identifier (preceded by a word char, `.` or `-`).
const MODEL_ID_RE = /(^|[^\w.-])(groq\/compound[\w./-]*|llama-[\w./-]+|openai\/gpt-oss[\w./-]*|qwen\/[\w./-]+|gemini-[0-9][\w./-]*|claude-(?:haiku|sonnet|opus)[\w.-]*)(?![\w.-])/;

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
    // Strip line comments without eating `https://` (or any `//`) inside a
    // string literal — a bare `.replace(/\/\/.*$/gm, '')` ate everything
    // after the first `//` in a URL literal, hiding a model id embedded
    // further along that same line.
    const stripped = src.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(MODEL_ID_RE);
  });

  test('comment stripper keeps a URL literal but still strips a real comment', () => {
    const u = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    const src = `const u = '${u}';\n// gemini-2.5-flash\n`;
    const stripped = src.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).toContain(u);
    expect(MODEL_ID_RE.test(stripped)).toBe(true);

    const commentOnly = '// gemini-2.5-flash\n';
    const strippedCommentOnly = commentOnly.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(MODEL_ID_RE.test(strippedCommentOnly)).toBe(false);
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
