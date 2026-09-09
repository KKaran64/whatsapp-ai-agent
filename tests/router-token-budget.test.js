// The router classified EVERY non-pattern message as FALLBACK.
//
// Cause: max_tokens was 10, tuned when the model was llama-3.1-8b-instant,
// which emitted the node name directly. The replacement (openai/gpt-oss-*) is
// a REASONING model: it spends tokens on hidden reasoning before writing any
// content, so a 10-token budget was consumed entirely by reasoning and the
// completion came back empty. Measured against the live API:
//
//   max_tokens=500  finish=stop    content=135 chars  reasoning=348
//   max_tokens=80   finish=length  content=4          reasoning=337
//   max_tokens=10   finish=length  content=0          reasoning=29
//
// So a token budget is not a property of the caller alone — it depends on
// whether the configured model reasons. Making the model configurable without
// making the budget follow it is what broke this.

const { MODELS, supportsReasoningEffort, REASONING_EFFORT } = require('../config/models');

describe('reasoning support is decided per model, never assumed', () => {
  test('gpt-oss and qwen support reasoning_effort', () => {
    expect(supportsReasoningEffort('openai/gpt-oss-120b')).toBe(true);
    expect(supportsReasoningEffort('openai/gpt-oss-20b')).toBe(true);
    expect(supportsReasoningEffort('qwen/qwen3.8-27b')).toBe(true);
  });

  test('groq/compound does NOT — sending it there is a hard 400', () => {
    // Verified live: "`reasoning_effort` is not supported with this model".
    // Sending it unconditionally would be another self-inflicted outage.
    expect(supportsReasoningEffort('groq/compound-mini')).toBe(false);
    expect(supportsReasoningEffort('groq/compound')).toBe(false);
  });

  test('an unknown model is assumed NOT to support it', () => {
    // Fail safe: omitting the parameter costs a few tokens, sending it to a
    // model that rejects it costs every reply.
    expect(supportsReasoningEffort('some/future-model')).toBe(false);
    expect(supportsReasoningEffort('')).toBe(false);
    expect(supportsReasoningEffort(undefined)).toBe(false);
  });

  test('the configured effort is a valid Groq value', () => {
    expect(['low', 'medium', 'high']).toContain(REASONING_EFFORT);
  });
});

describe('token budgets leave room for a reply after reasoning', () => {
  const { TOKEN_BUDGETS } = require('../config/models');

  test('every budget clears the floor a reasoning model needs', () => {
    // 10 tokens produced empty content; 80 produced 4 characters. Anything at
    // or below that ships a non-answer.
    for (const [name, n] of Object.entries(TOKEN_BUDGETS)) {
      expect(n).toBeGreaterThanOrEqual(100);
    }
  });

  test('the router budget specifically is no longer 10', () => {
    expect(TOKEN_BUDGETS.ROUTER).toBeGreaterThan(10);
  });
});

describe('the router asks for a budget it can actually answer within', () => {
  const RouterAgent = require('../optimized-bot/router-agent');

  test('classify passes the configured budget, not a hardcoded 10', async () => {
    const router = new RouterAgent({ GROQ_API_KEY: 'test' });
    let seen = null;
    router.groqClients = [{
      chat: { completions: { create: async (args) => { seen = args; return { choices: [{ message: { content: 'COASTERS' } }] }; } } }
    }];
    router.currentKeyIndex = 0;

    await router._classifyWithLLM('something with no pattern match at all xyzzy');

    expect(seen.max_tokens).toBe(TOKEN_BUDGETS.ROUTER);
    expect(seen.max_tokens).toBeGreaterThan(10);
  });

  test('reasoning_effort is included when the model supports it', async () => {
    const router = new RouterAgent({ GROQ_API_KEY: 'test' });
    let seen = null;
    router.groqClients = [{
      chat: { completions: { create: async (args) => { seen = args; return { choices: [{ message: { content: 'START' } }] }; } } }
    }];
    router.currentKeyIndex = 0;

    await router._classifyWithLLM('xyzzy');

    if (supportsReasoningEffort(MODELS.GROQ_FAST)) {
      expect(seen.reasoning_effort).toBe(REASONING_EFFORT);
    } else {
      expect(seen.reasoning_effort).toBeUndefined();
    }
  });
});

const { TOKEN_BUDGETS } = require('../config/models');
