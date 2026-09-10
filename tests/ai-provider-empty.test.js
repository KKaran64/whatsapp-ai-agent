// Each provider call ended with `content || "I'm here to help!"`. That default
// counted an empty completion as a SUCCESS, shipped the placeholder to the
// customer, and returned immediately — so key rotation and the Gemini fallback
// never got their chance. A recoverable provider hiccup became an
// unrecoverable non-answer, while success metrics stayed clean.
//
// That is the literal string a customer received on 2026-09-08 after asking
// "what all sizes you have?".
//
// Empty content is a failure. It must throw so the retry paths that already
// exist can do their job.

const AIProviderManager = require('../ai-provider-manager');

function managerWith(...responses) {
  const m = new AIProviderManager({ GROQ_API_KEY: 'k1', GROQ_API_KEY_2: 'k2' });
  const calls = [];
  m.groqClients = responses.map(r => ({
    chat: { completions: { create: async (args) => { calls.push(args); if (r instanceof Error) throw r; return r; } } }
  }));
  m.currentGroqIndex = 0;
  m.geminiKeys = [];
  return { m, calls };
}

const EMPTY = { choices: [{ message: { content: '' } }] };
const NO_FIELD = { choices: [{ message: {} }] };
const BLANK = { choices: [{ message: { content: '   \n ' } }] };
const GOOD = { choices: [{ message: { content: 'We have cork yoga mats in 3mm and 5mm.' } }] };

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('an empty completion is a failure, not an answer', () => {
  test('the placeholder never reaches the customer when another key works', async () => {
    const { m } = managerWith(EMPTY, GOOD);
    const r = await m.tryGroq('sys', [], 'what all sizes you have?');
    expect(r.response).not.toMatch(/I'm here to help!/);
    expect(r.response).toMatch(/yoga mats/);
  });

  test('it rotates to the next key instead of giving up', async () => {
    const { m, calls } = managerWith(EMPTY, GOOD);
    await m.tryGroq('sys', [], 'hello');
    expect(calls).toHaveLength(2);
  });

  test.each([
    ['empty string', EMPTY],
    ['missing content field', NO_FIELD],
    ['whitespace only', BLANK]
  ])('%s counts as empty', async (_l, bad) => {
    const { m } = managerWith(bad, GOOD);
    const r = await m.tryGroq('sys', [], 'hello');
    expect(r.response).toMatch(/yoga mats/);
  });

  test('throws when every key is empty, so the caller can fall back to Gemini', async () => {
    const { m } = managerWith(EMPTY, EMPTY);
    await expect(m.tryGroq('sys', [], 'hello')).rejects.toThrow();
  });

  test('an all-empty run is not counted as a success', async () => {
    const { m } = managerWith(EMPTY, EMPTY);
    const before = m.stats.groq.success;
    await m.tryGroq('sys', [], 'hello').catch(() => {});
    expect(m.stats.groq.success).toBe(before);
  });
});

describe('normal replies are unaffected', () => {
  test('a good reply returns and is counted once', async () => {
    const { m, calls } = managerWith(GOOD);
    const before = m.stats.groq.success;
    const r = await m.tryGroq('sys', [], 'hello');
    expect(r.response).toMatch(/yoga mats/);
    expect(calls).toHaveLength(1);
    expect(m.stats.groq.success).toBe(before + 1);
  });
});
