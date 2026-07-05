// Tests for pricing/groq-client.js — shared Groq JSON caller.
// Contract: returns parsed JSON on success, null when unavailable.
// Never throws. Total wall-clock across key attempts is bounded by budgetMs.

jest.mock('axios');
const axios = require('axios');

const { callGroqJson, collectGroqKeys, DEFAULT_BUDGET_MS, MIN_ATTEMPT_MS } = require('../pricing/groq-client');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

const GROQ_ENV_KEYS = [
  'GROQ_API_KEY',
  ...Array.from({ length: 9 }, (_, i) => `GROQ_API_KEY_${i + 2}`)
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of GROQ_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  axios.post.mockReset();
});

afterEach(() => {
  for (const k of GROQ_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function groqReply(obj) {
  return { data: { choices: [{ message: { content: JSON.stringify(obj) } }] } };
}

const MESSAGES = [
  { role: 'system', content: 'return json' },
  { role: 'user', content: 'hello' }
];

describe('collectGroqKeys', () => {
  test('collects GROQ_API_KEY and numbered variants in order', () => {
    process.env.GROQ_API_KEY = 'k1';
    process.env.GROQ_API_KEY_2 = 'k2';
    process.env.GROQ_API_KEY_5 = 'k5';
    expect(collectGroqKeys()).toEqual(['k1', 'k2', 'k5']);
  });

  test('returns empty array when nothing configured', () => {
    expect(collectGroqKeys()).toEqual([]);
  });
});

describe('callGroqJson', () => {
  test('returns parsed JSON on success', async () => {
    process.env.GROQ_API_KEY = 'k1';
    axios.post.mockResolvedValue(groqReply({ hello: 'world' }));
    const result = await callGroqJson(MESSAGES);
    expect(result).toEqual({ hello: 'world' });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('returns null when no keys configured, without calling axios', async () => {
    const result = await callGroqJson(MESSAGES);
    expect(result).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('fails over to the next key and succeeds', async () => {
    process.env.GROQ_API_KEY = 'dead';
    process.env.GROQ_API_KEY_2 = 'good';
    axios.post
      .mockRejectedValueOnce({ response: { data: { error: { message: 'rate limited' } } } })
      .mockResolvedValueOnce(groqReply({ ok: true }));
    const result = await callGroqJson(MESSAGES);
    expect(result).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('returns null when every key fails', async () => {
    process.env.GROQ_API_KEY = 'k1';
    process.env.GROQ_API_KEY_2 = 'k2';
    axios.post.mockRejectedValue(new Error('network down'));
    const result = await callGroqJson(MESSAGES);
    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('unparseable model output counts as a key failure', async () => {
    process.env.GROQ_API_KEY = 'k1';
    process.env.GROQ_API_KEY_2 = 'k2';
    axios.post
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'not json {' } }] } })
      .mockResolvedValueOnce(groqReply({ ok: true }));
    const result = await callGroqJson(MESSAGES);
    expect(result).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('passes the remaining budget as the per-call axios timeout', async () => {
    process.env.GROQ_API_KEY = 'k1';
    axios.post.mockResolvedValue(groqReply({ ok: true }));
    await callGroqJson(MESSAGES, { budgetMs: 1500 });
    const config = axios.post.mock.calls[0][2];
    expect(config.timeout).toBeGreaterThan(0);
    expect(config.timeout).toBeLessThanOrEqual(1500);
  });

  test('stops failing over once the budget is spent', async () => {
    process.env.GROQ_API_KEY = 'slow-dead';
    process.env.GROQ_API_KEY_2 = 'would-succeed';
    axios.post
      .mockImplementationOnce(() => new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 500)))
      .mockResolvedValueOnce(groqReply({ ok: true }));
    const result = await callGroqJson(MESSAGES, { budgetMs: 350 });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  test('a budget below the minimum attempt window makes zero calls', async () => {
    process.env.GROQ_API_KEY = 'k1';
    axios.post.mockResolvedValue(groqReply({ ok: true }));
    const result = await callGroqJson(MESSAGES, { budgetMs: 50 });
    expect(axios.post).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('exports sane budget constants', () => {
    expect(DEFAULT_BUDGET_MS).toBe(3000);
    expect(MIN_ATTEMPT_MS).toBe(300);
  });
});
