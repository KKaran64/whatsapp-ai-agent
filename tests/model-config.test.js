const fs = require('fs');
const path = require('path');
const { MODELS, TOKEN_BUDGETS, reasoningParams, supportsReasoningEffort } = require('../config/models');

const CALL_SITES = [
  'ai-provider-manager.js',
  'optimized-bot/router-agent.js',
  'optimized-bot/responder-agent.js',
  'pricing/groq-client.js',
  'rag/classifier.js',
  'scripts/weekly-cron.js',
];
// Any literal that looks like a model id. compound/llama are retired; the
// others must come from config/models.js, never be typed at a call site.
const MODEL_ID_RE = /['"`](groq\/compound[^'"`]*|llama-[^'"`]+|openai\/gpt-oss[^'"`]*|qwen\/[^'"`]+|gemini-[0-9][^'"`]*|claude-[^'"`]+)['"`]/;

describe('config/models', () => {
  test('exports every model slot as a non-empty string', () => {
    for (const k of ['GROQ_CHAT', 'GROQ_FAST', 'GROQ_JSON', 'GEMINI_CHAT', 'GEMINI_VISION', 'GROQ_WHISPER', 'CLAUDE_FALLBACK']) {
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
});
