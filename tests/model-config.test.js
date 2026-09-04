// 2026-09-05 outage: Groq retired all Llama chat models and Google retired
// gemini-2.0-flash within days of each other. Every provider 404'd and every
// customer message became "I'm having trouble processing your message right
// now" — the bot answered nothing but hardcoded greetings.
//
// These tests lock in the two properties that turn a routine vendor
// deprecation back into a config change instead of an outage:
//   1. No functional file hardcodes a model id — one definition, imported.
//   2. Every id is env-overridable, so recovery needs a restart, not a deploy.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('model ids are defined in exactly one place', () => {
  // The files that actually call an LLM in production.
  const CALLERS = [
    'ai-provider-manager.js',
    'optimized-bot/router-agent.js',
    'optimized-bot/responder-agent.js',
    'pricing/groq-client.js',
    'rag/classifier.js'
  ];

  test.each(CALLERS)('%s contains no hardcoded model id', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    // Strip comments — an incident note naming a retired model is fine.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');

    const hardcoded = code.match(
      /['"](?:llama[\w.\-\/]*|gemini-[\w.\-]+|mixtral[\w.\-]*|gemma[\w.\-]*|openai\/gpt-oss[\w.\-]*|qwen\/[\w.\-]+)['"]/gi
    );
    expect(hardcoded).toBeNull();
  });

  test.each(CALLERS)('%s imports the shared model config', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    expect(src).toMatch(/require\(['"].*config\/models['"]\)/);
  });
});

describe('every model id is env-overridable', () => {
  const ENV_VARS = [
    ['GROQ_MODEL_CHAT', 'GROQ_CHAT'],
    ['GROQ_MODEL_FAST', 'GROQ_FAST'],
    ['GROQ_MODEL_JSON', 'GROQ_JSON'],
    ['GEMINI_MODEL_CHAT', 'GEMINI_CHAT'],
    ['GEMINI_MODEL_VISION', 'GEMINI_VISION']
  ];

  test.each(ENV_VARS)('%s overrides %s without a code change', (envVar, key) => {
    const prev = process.env[envVar];
    process.env[envVar] = 'vendor/replacement-model-v9';
    try {
      jest.resetModules();
      const { MODELS } = require('../config/models');
      expect(MODELS[key]).toBe('vendor/replacement-model-v9');
    } finally {
      if (prev === undefined) delete process.env[envVar];
      else process.env[envVar] = prev;
      jest.resetModules();
    }
  });
});

describe('defaults are sane', () => {
  test('every model id is a non-empty string', () => {
    const { MODELS } = require('../config/models');
    for (const [k, v] of Object.entries(MODELS)) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  test('no default points at a model the vendors retired in the 2026-09 outage', () => {
    const { MODELS } = require('../config/models');
    const RETIRED = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemini-2.0-flash', 'gemini-pro'];
    for (const v of Object.values(MODELS)) {
      expect(RETIRED).not.toContain(v);
    }
  });

  test('the JSON-mode model is not a gpt-oss model', () => {
    // openai/gpt-oss-* return HTTP 400 for response_format json_object.
    // intent-resolver and rag/classifier both depend on JSON mode; pointing
    // them at gpt-oss makes intent resolution fail silently and fall back to
    // the regex extractor, which disables the pricing guard.
    const { MODELS } = require('../config/models');
    expect(MODELS.GROQ_JSON).not.toMatch(/gpt-oss/);
  });
});
