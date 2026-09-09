// A customer asked "what all sizes you have?" and the bot replied
// "I'm here to help!" — a non-answer that reads like the bot ignored them.
//
// That string is not something an LLM wrote. It is the `|| "I'm here to
// help!"` default at the end of each provider call, used when the completion
// came back with empty content. The bug is what that default DOES:
//
//   const response = completion.choices[0]?.message?.content || "I'm here to help!";
//   this.stats.groq.success++;
//   return { provider: 'groq', response };
//
// An empty completion is counted as a SUCCESS, shipped to the customer, and —
// worst of all — returned immediately, so the Gemini fallback and the other
// API keys are never tried. A recoverable provider failure is converted into
// an unrecoverable non-answer.
//
// Empty content is a failure. It must throw, so the existing key rotation and
// provider fallback get their chance.

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
const NO_CONTENT = { choices: [{ message: {} }] };
const WHITESPACE = { choices: [{ message: { content: '   \n  ' } }] };
const GOOD = { choices: [{ message: { content: 'We have four cork yoga mats: 3mm, 5mm EVA, 5mm latex and 1.5mm.' } }] };

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('an empty completion is a failure, not an answer', () => {
  test('never returns the "I\'m here to help!" placeholder to the customer', async () => {
    const { m } = managerWith(EMPTY, GOOD);
    const r = await m.tryGroq('sys', [], 'what all sizes you have?');
    expect(r.response).not.toMatch(/I'm here to help!/);
  });

  test('rotates to the next key instead of giving up on the first empty reply', async () => {
    const { m, calls } = managerWith(EMPTY, GOOD);
    const r = await m.tryGroq('sys', [], 'what all sizes you have?');
    expect(calls).toHaveLength(2);
    expect(r.response).toMatch(/yoga mats/);
  });

  test.each([
    ['empty string', EMPTY],
    ['missing content field', NO_CONTENT],
    ['whitespace only', WHITESPACE]
  ])('%s counts as empty', async (_label, bad) => {
    const { m } = managerWith(bad, GOOD);
    const r = await m.tryGroq('sys', [], 'hello');
    expect(r.response).toMatch(/yoga mats/);
  });

  test('throws when EVERY key returns empty, so the caller can fall back to Gemini', async () => {
    const { m } = managerWith(EMPTY, EMPTY);
    await expect(m.tryGroq('sys', [], 'hello')).rejects.toThrow();
  });

  test('an all-empty run is not recorded as a success', async () => {
    const { m } = managerWith(EMPTY, EMPTY);
    const before = m.stats.groq.success;
    await m.tryGroq('sys', [], 'hello').catch(() => {});
    expect(m.stats.groq.success).toBe(before);
  });
});

describe('normal responses are unaffected', () => {
  test('a good reply is returned and counted once', async () => {
    const { m, calls } = managerWith(GOOD);
    const before = m.stats.groq.success;
    const r = await m.tryGroq('sys', [], 'hello');
    expect(r.response).toMatch(/yoga mats/);
    expect(calls).toHaveLength(1);
    expect(m.stats.groq.success).toBe(before + 1);
  });
});
