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
});
