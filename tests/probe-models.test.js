const { probeModels } = require('../scripts/probe-models');

function fakeFetch(map) {
  return async (url) => {
    for (const [prefix, body] of Object.entries(map)) {
      if (url.startsWith(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe('probeModels', () => {
  const env = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x' };

  test('passes when every configured id is listed', async () => {
    const f = fakeFetch({
      'https://api.groq.com': { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }, { id: 'whisper-large-v3-turbo' }] },
      'https://generativelanguage': { models: [{ name: 'models/gemini-3.6-flash' }, { name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-flash-lite' }] },
    });
    const r = await probeModels({ fetchImpl: f, env });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test('reports a missing id by provider and slot', async () => {
    const f = fakeFetch({
      'https://api.groq.com': { data: [{ id: 'openai/gpt-oss-120b' }] },
      'https://generativelanguage': { models: [{ name: 'models/gemini-3.6-flash' }, { name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-flash-lite' }] },
    });
    const r = await probeModels({ fetchImpl: f, env });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['groq:GROQ_FAST=openai/gpt-oss-20b', 'groq:GROQ_JSON=qwen/qwen3.8-27b']));
  });

  test('a provider that cannot be reached is an error, not a pass', async () => {
    const f = async () => { throw new Error('ECONNRESET'); };
    const r = await probeModels({ fetchImpl: f, env });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/groq.*ECONNRESET/);
  });

  test('skips a provider with no key configured', async () => {
    const f = fakeFetch({ 'https://api.groq.com': { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }, { id: 'whisper-large-v3-turbo' }] } });
    const r = await probeModels({ fetchImpl: f, env: { GROQ_API_KEY: 'g' } });
    expect(r.ok).toBe(true);
    expect(r.checked.some(c => c.startsWith('gemini'))).toBe(false);
  });

  test('an invalid first key does not fail the probe when a later key works', async () => {
    const byKey = {
      bad: { status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } },
      good: { status: 200, body: { models: [{ name: 'models/gemini-3.6-flash' }, { name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-flash-lite' }] } },
    };
    const f = async (url) => {
      if (url.startsWith('https://api.groq.com')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }, { id: 'whisper-large-v3-turbo' }] }) };
      const k = new URL(url).searchParams.get('key');
      const r = byKey[k];
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    };
    const r = await probeModels({ fetchImpl: f, env: { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'bad', GEMINI_API_KEY_2: 'good' } });
    expect(r.ok).toBe(true);
    expect(r.keys.gemini).toEqual({ total: 2, valid: 1 });
    expect(r.errors).toEqual(['gemini key#1: API key not valid. Please pass a valid API key.']);
    expect(JSON.stringify(r)).not.toMatch(/bad|good/);   // never echoes key material
  });

  test('all keys invalid for a provider fails the probe', async () => {
    const f = async (url) => url.startsWith('https://api.groq.com')
      ? { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }) }
      : { ok: true, status: 200, json: async () => ({ models: [] }) };
    const r = await probeModels({ fetchImpl: f, env: { GROQ_API_KEY: 'g1', GROQ_API_KEY_2: 'g2' } });
    expect(r.ok).toBe(false);
    expect(r.keys.groq).toEqual({ total: 2, valid: 0 });
    expect(r.errors).toHaveLength(2);
  });

  test('checks the Anthropic model when a key is configured and reports it missing', async () => {
    const f = fakeFetch({
      'https://api.groq.com': { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }, { id: 'whisper-large-v3-turbo' }] },
      'https://generativelanguage': { models: [{ name: 'models/gemini-3.6-flash' }, { name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-flash-lite' }] },
      'https://api.anthropic.com': { data: [{ id: 'claude-sonnet-5' }], has_more: false },
    });
    const r = await probeModels({ fetchImpl: f, env: { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'a' } });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['anthropic:CLAUDE_FALLBACK=claude-haiku-4-5']);
    expect(r.keys.anthropic).toEqual({ total: 1, valid: 1 });
  });

  test('skips Anthropic when no key is configured', async () => {
    const f = fakeFetch({
      'https://api.groq.com': { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }, { id: 'whisper-large-v3-turbo' }] },
      'https://generativelanguage': { models: [{ name: 'models/gemini-3.6-flash' }, { name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-flash-lite' }] },
    });
    const r = await probeModels({ fetchImpl: f, env });
    expect(r.checked.some(c => c.startsWith('anthropic'))).toBe(false);
    expect(r.keys.anthropic).toEqual({ total: 0, valid: 0 });
  });
});
