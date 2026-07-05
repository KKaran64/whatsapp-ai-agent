# LLM-First Intent Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-primary intent extractor with a single LLM extraction pass (product + refinements + quantity + customer-type + branding), retiring the v61.1 classifier and v61.2 disambiguator rescue layers.

**Architecture:** One Groq call per inbound message fills a structured intent form; the deterministic `quote-engine.js` (now refinement-aware) selects the SKU and computes the price. The LLM never sees the catalog and cannot name a SKU or price. Regex extractor is kept as an automatic fallback (flagged in telemetry) and behind an `INTENT_RESOLVER=regex` kill-switch.

**Tech Stack:** Node.js 18+, Express 4, axios (Groq REST), Jest 30 (mocked axios, env-controlled keys)

**Spec:** `docs/superpowers/specs/2026-07-05-llm-first-intent-design.md`

## Global Constraints

- Groq model: `llama-3.3-70b-versatile` via `https://api.groq.com/openai/v1/chat/completions` (same as existing modules)
- Wall-clock budget: default 3000 ms total across all key attempts; minimum attempt window 300 ms; remaining budget = per-attempt axios timeout
- Groq keys: `GROQ_API_KEY`, `GROQ_API_KEY_2` … `GROQ_API_KEY_10`, tried in order
- Confidence gate: `< 0.6` → do not quote, ask clarifying question (applies to `source: 'llm'` only; regex fallback is `confidence: 1.0` to preserve today's behavior during outages)
- Kill-switch: `INTENT_RESOLVER=llm` (default) | `regex`
- Refinement boost: +25 per matching positive refinement, capped at 99 (a boost must never fake an exact-match score of 100); negative refinements (`'!yoga'`) exclude candidates
- Pricing math in `quote-engine.js` must not change: with `refinements: []` the engine's behavior must be byte-identical to today
- Test conventions: `jest.mock('axios')`, console suppressed in `beforeAll`, Groq env keys snapshot/restored per test (see `tests/llm-disambiguator.test.js` for the pattern)
- **Working-tree note:** the repo currently has UNCOMMITTED v61.2 changes (`pricing/llm-disambiguator.js`, its `server.js` wiring at lines 2844–2900, `tests/llm-disambiguator.test.js`). This plan supersedes them: Task 1 lifts the budget loop out of the disambiguator, Task 4 removes its server wiring, Task 6 deletes the files. Do NOT commit the v61.2 work separately.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `pricing/groq-client.js` | Create | Shared Groq JSON caller: key collection, failover, wall-clock budget |
| `tests/groq-client.test.js` | Create | Budget/failover tests (adapted from disambiguator suite) |
| `pricing/intent-resolver.js` | Create | LLM-first extraction, schema validation, regex fallback, kill-switch, stats |
| `tests/intent-resolver.test.js` | Create | Extraction, validation, fallback, kill-switch tests |
| `pricing/quote-engine.js` | Modify | `findProducts`/`computeQuote` become refinement-aware |
| `tests/quote-engine-refinements.test.js` | Create | Refinement boost/exclude + no-refinement regression |
| `server.js` | Modify | Call resolver per turn; delete disambiguator block; confidence gate; `/stats` counter |
| `tests/office-mats-regression.test.js` | Create | End-to-end resolver→engine test of the refinement-loss bug |
| `pricing/conversation-state.js` | Modify (Task 6) | Remove dead llm-classifier branch |
| `pricing/llm-classifier.js`, `pricing/llm-disambiguator.js`, `tests/llm-disambiguator.test.js` | Delete (Task 6) | Retired rescue layers |
| `render.yaml`, `.env.example` | Modify (Task 6) | Add `INTENT_RESOLVER` |

---

### Task 1: Shared Groq client (`pricing/groq-client.js`)

**Files:**
- Create: `pricing/groq-client.js`
- Test: `tests/groq-client.test.js`

**Interfaces:**
- Consumes: nothing (leaf module; axios + env only)
- Produces: `callGroqJson(messages, options?) → Promise<object|null>` where `options = { budgetMs?: number (default 3000), maxTokens?: number (default 500), temperature?: number (default 0.1) }`. Returns the parsed JSON object from the model, or `null` when unavailable (no keys configured, budget spent, or every key failed). Also exports `collectGroqKeys()`, `DEFAULT_BUDGET_MS`, `MIN_ATTEMPT_MS` for tests.

- [ ] **Step 1: Write the failing test**

Create `tests/groq-client.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/groq-client.test.js`
Expected: FAIL with `Cannot find module '../pricing/groq-client'`

- [ ] **Step 3: Write the implementation**

Create `pricing/groq-client.js` (the budget loop is lifted from the uncommitted v61.2 `pricing/llm-disambiguator.js`):

```js
// Shared Groq JSON client — single source of truth for the Groq REST plumbing
// that was previously copy-pasted across llm-classifier.js and
// llm-disambiguator.js: key collection, multi-key failover, and the
// wall-clock budget introduced in v61.2.
//
// Contract: callGroqJson(messages, options) returns the model's parsed JSON
// object, or null when the LLM is unavailable (no keys, budget spent, or all
// keys failed). It NEVER throws — callers branch on null and degrade.

const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

// Total wall-clock across ALL key attempts. A customer is waiting on the
// interactive path, so failed keys must never stack their timeouts.
const DEFAULT_BUDGET_MS = 3000;
// Below this remaining window a call can't realistically complete — stop.
const MIN_ATTEMPT_MS = 300;

function collectGroqKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

async function callOnce(messages, apiKey, timeoutMs, maxTokens, temperature) {
  const response = await axios.post(GROQ_URL, {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' }
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: timeoutMs
  });
  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty Groq response');
  return JSON.parse(content);
}

async function callGroqJson(messages, options = {}) {
  const budgetMs = options.budgetMs > 0 ? options.budgetMs : DEFAULT_BUDGET_MS;
  const maxTokens = options.maxTokens || 500;
  const temperature = options.temperature ?? 0.1;

  const keys = collectGroqKeys();
  if (keys.length === 0) return null;

  const errors = [];
  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < keys.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      errors.push(`budget spent after ${i} key(s)`);
      break;
    }
    try {
      return await callOnce(messages, keys[i], remaining, maxTokens, temperature);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      errors.push(`key#${i + 1}: ${String(msg).substring(0, 80)}`);
    }
  }
  console.warn(`⚠️ groq-client: unavailable (${errors.join(' | ')})`);
  return null;
}

module.exports = {
  callGroqJson,
  collectGroqKeys,
  GROQ_URL,
  MODEL,
  DEFAULT_BUDGET_MS,
  MIN_ATTEMPT_MS
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/groq-client.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add pricing/groq-client.js tests/groq-client.test.js
git commit -m "feat: shared groq-client with multi-key failover + wall-clock budget"
```

---

### Task 2: Intent resolver (`pricing/intent-resolver.js`)

**Files:**
- Create: `pricing/intent-resolver.js`
- Test: `tests/intent-resolver.test.js`

**Interfaces:**
- Consumes: `callGroqJson(messages, {budgetMs})` from Task 1; `extractIntent(currentMessage, contextMessages)` from `pricing/intent-extractor.js` (existing regex module, returns `{productQuery, quantity, customerType, branding}` or `null`)
- Produces:
  - `resolveIntent(currentMessage, contextMessages, options?) → Promise<Intent|null>` where `options = { budgetMs?: number }` and `Intent = { productQuery: string|null, refinements: string[], quantity: number|null, customerType: 'end_consumer'|'reseller'|null, branding: 'single-color'|'pad-printing'|'multi-color'|'laser'|null, confidence: number, source: 'llm'|'regex_fallback', reasoning: string }`. Returns `null` when the turn carries no pricing intent (all business fields empty).
  - `getResolverStats() → { llm: number, regexFallback: number, noIntent: number }` (process-lifetime counters; server `/stats` exposes them)

- [ ] **Step 1: Write the failing test**

Create `tests/intent-resolver.test.js`:

```js
// Tests for pricing/intent-resolver.js — LLM-first intent extraction.
// The groq-client is mocked at the module boundary; the regex fallback
// (intent-extractor) runs for real so fallback behavior matches production.

jest.mock('../pricing/groq-client', () => ({
  callGroqJson: jest.fn(),
  DEFAULT_BUDGET_MS: 3000
}));
const { callGroqJson } = require('../pricing/groq-client');
const { resolveIntent, getResolverStats } = require('../pricing/intent-resolver');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  callGroqJson.mockReset();
  delete process.env.INTENT_RESOLVER;
});

const CONTEXT = [
  { role: 'user', content: 'i need 200 mats for office, for my own use' },
  { role: 'assistant', content: 'We have Coffee Mat, Desktop Mat, Yoga Mat — which one?' },
  { role: 'user', content: 'for office work desktop mats are better right' }
];

describe('resolveIntent — LLM path', () => {
  test('returns validated intent from the LLM', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'mat',
      refinements: ['desktop', 'office'],
      quantity: 200,
      customerType: 'end_consumer',
      branding: null,
      confidence: 0.9,
      reasoning: 'customer wants desktop mats for own office use'
    });

    const intent = await resolveIntent('what are the other options?', CONTEXT);

    expect(intent).toEqual({
      productQuery: 'mat',
      refinements: ['desktop', 'office'],
      quantity: 200,
      customerType: 'end_consumer',
      branding: null,
      confidence: 0.9,
      source: 'llm',
      reasoning: 'customer wants desktop mats for own office use'
    });
  });

  test('returns null when the LLM reports no pricing intent (all business fields null)', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: null, refinements: [], quantity: null,
      customerType: null, branding: null,
      confidence: 0.95, reasoning: 'greeting only'
    });
    const intent = await resolveIntent('hello!', []);
    expect(intent).toBeNull();
  });

  test('coerces and sanitizes malformed fields individually', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: '  diary ',
      refinements: ['A5', 42, '  ', 'premium'],
      quantity: '150',                 // numeric string → number
      customerType: 'wholesaler',      // not in enum → null
      branding: 'glitter',             // not in enum → null
      confidence: '0.8',               // numeric string → number
      reasoning: 'x'.repeat(500)
    });

    const intent = await resolveIntent('150 A5 diaries', []);

    expect(intent.productQuery).toBe('diary');
    expect(intent.refinements).toEqual(['a5', 'premium']);
    expect(intent.quantity).toBe(150);
    expect(intent.customerType).toBeNull();
    expect(intent.branding).toBeNull();
    expect(intent.confidence).toBe(0.8);
    expect(intent.reasoning.length).toBeLessThanOrEqual(200);
  });

  test('nonsense quantity is nulled, not passed through', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'coaster', refinements: [], quantity: 'two hundred',
      customerType: 'reseller', branding: null, confidence: 0.9, reasoning: 'ok'
    });
    const intent = await resolveIntent('coasters', []);
    expect(intent.quantity).toBeNull();
  });

  test('invalid confidence defaults to 0.5', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'coaster', refinements: [], quantity: 10,
      customerType: null, branding: null, confidence: 'very sure', reasoning: 'ok'
    });
    const intent = await resolveIntent('10 coasters', []);
    expect(intent.confidence).toBe(0.5);
  });
});

describe('resolveIntent — regex fallback', () => {
  test('falls back to regex when groq-client returns null, with source flag and confidence 1.0', async () => {
    callGroqJson.mockResolvedValue(null);

    const intent = await resolveIntent('price for 100 cork diaries for my office', []);

    expect(intent.source).toBe('regex_fallback');
    expect(intent.confidence).toBe(1.0);
    expect(intent.refinements).toEqual([]);
    expect(intent.productQuery).toBeTruthy();  // regex extractor found "diary"
    expect(intent.quantity).toBe(100);
    expect(intent.customerType).toBe('end_consumer');
  });

  test('fallback returns null for non-pricing chatter (same as regex today)', async () => {
    callGroqJson.mockResolvedValue(null);
    const intent = await resolveIntent('thanks, bye!', []);
    expect(intent).toBeNull();
  });

  test('kill-switch INTENT_RESOLVER=regex skips the LLM entirely', async () => {
    process.env.INTENT_RESOLVER = 'regex';
    const intent = await resolveIntent('price for 100 cork diaries for my office', []);
    expect(callGroqJson).not.toHaveBeenCalled();
    expect(intent.source).toBe('regex_fallback');
  });
});

describe('getResolverStats', () => {
  test('counts llm successes and regex fallbacks', async () => {
    const before = getResolverStats();

    callGroqJson.mockResolvedValueOnce({
      productQuery: 'mat', refinements: [], quantity: 5,
      customerType: 'reseller', branding: null, confidence: 0.9, reasoning: 'ok'
    });
    await resolveIntent('5 mats', []);

    callGroqJson.mockResolvedValueOnce(null);
    await resolveIntent('price for 100 cork diaries', []);

    const after = getResolverStats();
    expect(after.llm).toBe(before.llm + 1);
    expect(after.regexFallback).toBe(before.regexFallback + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/intent-resolver.test.js`
Expected: FAIL with `Cannot find module '../pricing/intent-resolver'`

- [ ] **Step 3: Write the implementation**

Create `pricing/intent-resolver.js`:

```js
// Intent Resolver — LLM-first extraction (replaces regex-primary extraction).
//
// One Groq call per inbound message reads the recent conversation and fills
// the intent form the quote engine needs. The LLM only UNDERSTANDS — it never
// sees the catalog, never names a SKU, never computes a price. Selection and
// pricing stay in the deterministic quote-engine.
//
// Fallback ladder:
//   INTENT_RESOLVER=regex env        → regex extractor (kill-switch)
//   groq-client returns null         → regex extractor, source:'regex_fallback'
//   LLM output field invalid         → that FIELD nulled, rest kept
//
// Regex fallback keeps confidence 1.0 so quoting continues through an LLM
// outage exactly as it does today (the confidence gate applies to llm source).

const { callGroqJson, DEFAULT_BUDGET_MS } = require('./groq-client');
const { extractIntent } = require('./intent-extractor');

const CUSTOMER_TYPES = new Set(['end_consumer', 'reseller']);
const BRANDING_KEYS = new Set(['single-color', 'pad-printing', 'multi-color', 'laser']);

// Process-lifetime telemetry — exposed on /stats so degraded turns are visible.
const stats = { llm: 0, regexFallback: 0, noIntent: 0 };
function getResolverStats() {
  return { ...stats };
}

const SYSTEM_PROMPT = `You extract purchase intent from a WhatsApp sales conversation for a cork products business.

Read the conversation (most recent message last) and fill this JSON form. Output ONLY the JSON object, no prose:

{
  "productQuery": "<the product noun phrase the customer wants, e.g. 'mat', 'diary', 'bar caddy'; null if none>",
  "refinements": ["<narrowing terms the customer stated: variants, sizes, materials, use-case qualifiers like 'desktop', 'a5', 'round'; prefix '!' for explicit rejections like '!yoga'>"],
  "quantity": <integer number of pieces, or null>,
  "customerType": "end_consumer" | "reseller" | null,
  "branding": "single-color" | "pad-printing" | "multi-color" | "laser" | null,
  "confidence": <0.0-1.0 how sure you are about the OVERALL extraction>,
  "reasoning": "<one sentence>"
}

Rules:
- productQuery is the customer's own noun phrase, NEVER a catalog SKU name you invent.
- refinements accumulate across the WHOLE conversation. If the customer narrowed earlier ("for office work desktop mats are better") and later asks something else, KEEP the narrowing.
- customerType: buying for their own use/business (hotel, office, gifting their employees) = end_consumer; buying to resell/distribute = reseller. null if unstated.
- branding only if the customer asked for logo/printing/engraving. "with logo" = single-color.
- If the conversation has NO purchase/pricing intent at all (greeting, thanks, support question), return all business fields null with high confidence.
- Numbers written as words ("two hundred") → the integer (200).

Examples:

Conversation:
  customer: i need 200 mats for office, for my own use
  assistant: We have Coffee Mat, Desktop Mat, Yoga Mat — which one?
  customer: for office work desktop mats are better right
  customer: what are the other options?
→ {"productQuery": "mat", "refinements": ["desktop", "office"], "quantity": 200, "customerType": "end_consumer", "branding": null, "confidence": 0.9, "reasoning": "wants desktop mats for own office use; refinement kept while exploring options"}

Conversation:
  customer: i need diaries for corporate gifting to my clients
  customer: A5 size, around 150 pcs with our logo
→ {"productQuery": "diary", "refinements": ["a5"], "quantity": 150, "customerType": "end_consumer", "branding": "single-color", "confidence": 0.9, "reasoning": "corporate gifting for own clients, A5 diaries with logo"}

Conversation:
  customer: hello, are you there?
→ {"productQuery": null, "refinements": [], "quantity": null, "customerType": null, "branding": null, "confidence": 0.95, "reasoning": "greeting only, no purchase intent"}

Conversation:
  customer: show me mats but not yoga ones, i'm a distributor
→ {"productQuery": "mat", "refinements": ["!yoga"], "quantity": null, "customerType": "reseller", "branding": null, "confidence": 0.85, "reasoning": "distributor wants non-yoga mats"}`;

// ── Field-level validation: a bad field is nulled, the rest survives. ──
function validateIntent(raw) {
  const out = {
    productQuery: null,
    refinements: [],
    quantity: null,
    customerType: null,
    branding: null,
    confidence: 0.5,
    reasoning: ''
  };
  if (!raw || typeof raw !== 'object') return out;

  if (typeof raw.productQuery === 'string' && raw.productQuery.trim()) {
    out.productQuery = raw.productQuery.trim();
  }
  if (Array.isArray(raw.refinements)) {
    out.refinements = raw.refinements
      .filter(r => typeof r === 'string' && r.trim())
      .map(r => r.trim().toLowerCase())
      .slice(0, 6);
  }
  const qty = Number(raw.quantity);
  if (Number.isFinite(qty) && Number.isInteger(qty) && qty >= 1 && qty <= 99999) {
    out.quantity = qty;
  }
  if (CUSTOMER_TYPES.has(raw.customerType)) out.customerType = raw.customerType;
  if (BRANDING_KEYS.has(raw.branding)) out.branding = raw.branding;
  const conf = Number(raw.confidence);
  if (Number.isFinite(conf) && conf >= 0 && conf <= 1) out.confidence = conf;
  out.reasoning = String(raw.reasoning || '').substring(0, 200);
  return out;
}

function regexFallback(currentMessage, contextMessages, why) {
  const regexIntent = extractIntent(currentMessage, contextMessages);
  if (!regexIntent) {
    stats.noIntent++;
    return null;
  }
  stats.regexFallback++;
  console.warn(`⚠️ intent-resolver: regex_fallback — ${why}`);
  return {
    productQuery: regexIntent.productQuery || null,
    refinements: [],
    quantity: regexIntent.quantity || null,
    customerType: regexIntent.customerType || null,
    branding: regexIntent.branding || null,
    confidence: 1.0,
    source: 'regex_fallback',
    reasoning: `regex fallback (${why})`
  };
}

async function resolveIntent(currentMessage, contextMessages = [], options = {}) {
  if (!currentMessage || typeof currentMessage !== 'string') return null;

  if (process.env.INTENT_RESOLVER === 'regex') {
    return regexFallback(currentMessage, contextMessages, 'kill-switch INTENT_RESOLVER=regex');
  }

  // Same conversation window the regex extractor uses: last 10 messages.
  const windowLines = [
    ...contextMessages.slice(-10).map(m => {
      const who = (m.role === 'user' || m.role === 'customer') ? 'customer' : 'assistant';
      return `${who}: ${String(m.content || '').substring(0, 400)}`;
    }),
    `customer: ${currentMessage.substring(0, 800)}`
  ];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Conversation:\n${windowLines.join('\n')}\n\nFill the intent form. JSON only.` }
  ];

  const raw = await callGroqJson(messages, { budgetMs: options.budgetMs || DEFAULT_BUDGET_MS });
  if (raw === null) {
    return regexFallback(currentMessage, contextMessages, 'llm unavailable');
  }

  const intent = validateIntent(raw);

  // All business fields empty → this turn carries no pricing intent.
  if (!intent.productQuery && !intent.quantity && !intent.customerType && !intent.branding) {
    stats.noIntent++;
    return null;
  }

  stats.llm++;
  return { ...intent, source: 'llm' };
}

module.exports = {
  resolveIntent,
  getResolverStats,
  // exported for tests
  validateIntent
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/intent-resolver.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add pricing/intent-resolver.js tests/intent-resolver.test.js
git commit -m "feat: LLM-first intent resolver with regex fallback + kill-switch"
```

---

### Task 3: Refinement-aware quote engine

**Files:**
- Modify: `pricing/quote-engine.js:136-158` (findProducts), `pricing/quote-engine.js:172-199` (computeQuote signature + ambiguity block untouched)
- Test: `tests/quote-engine-refinements.test.js`

**Interfaces:**
- Consumes: existing `scoreMatch`, `stem`, `loadCatalog` internals (unchanged)
- Produces: `findProducts(query, refinements = [])` and `computeQuote({ productQuery, quantity, customerType, branding, refinements })`. With `refinements` empty/omitted, behavior is byte-identical to today. Positive refinement token present in a product name (stemmed) → +25 score, capped at 99. Refinement starting `'!'` → candidates whose name contains that token are excluded.

- [ ] **Step 1: Write the failing test**

Create `tests/quote-engine-refinements.test.js`:

```js
// Refinement-aware product selection. Uses the REAL catalog via loadCatalog(),
// so assertions are phrased structurally (score ordering, exclusion) rather
// than against exact catalog rows where possible.

const {
  findProducts,
  computeQuote
} = require('../pricing/quote-engine');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

describe('findProducts with refinements', () => {
  test('no refinements → identical result to the one-arg call (regression guard)', () => {
    const before = findProducts('mat');
    const after = findProducts('mat', []);
    expect(after).toEqual(before);
  });

  test('positive refinement boosts matching candidates to the top', () => {
    const plain = findProducts('mat');
    // Meaningful only if "mat" is genuinely ambiguous in the catalog
    expect(plain.length).toBeGreaterThan(1);

    const refined = findProducts('mat', ['desktop']);
    expect(refined[0].name.toLowerCase()).toContain('desktop');
    expect(refined[0].score).toBeGreaterThan(refined[1] ? refined[1].score : 0);
  });

  test('boost never fakes an exact match (capped at 99)', () => {
    const refined = findProducts('mat', ['desktop']);
    const boosted = refined.filter(c => c.name.toLowerCase().includes('desktop'));
    for (const c of boosted) {
      expect(c.score).toBeLessThanOrEqual(99);
    }
  });

  test('negative refinement excludes candidates', () => {
    const refined = findProducts('mat', ['!yoga']);
    expect(refined.every(c => !/\byoga\b/i.test(c.name))).toBe(true);
  });

  test('refinement tokens are stemmed (plural refinement still matches)', () => {
    const refined = findProducts('mat', ['desktops']);
    expect(refined[0].name.toLowerCase()).toContain('desktop');
  });
});

describe('computeQuote with refinements', () => {
  test('ambiguous "mat" becomes a found quote with the desktop refinement', () => {
    const withoutRefinement = computeQuote({
      productQuery: 'mat', quantity: 200, customerType: 'end_consumer'
    });
    expect(withoutRefinement.found).toBe(false);
    expect(withoutRefinement.error).toBe('multiple_matches');

    const withRefinement = computeQuote({
      productQuery: 'mat', quantity: 200, customerType: 'end_consumer',
      refinements: ['desktop']
    });
    expect(withRefinement.found).toBe(true);
    expect(withRefinement.product.name.toLowerCase()).toContain('desktop');
    expect(withRefinement.grandTotal).toBeGreaterThan(0);
  });

  test('refinements that match nothing leave the ambiguity untouched', () => {
    const result = computeQuote({
      productQuery: 'mat', quantity: 200, customerType: 'end_consumer',
      refinements: ['holographic']
    });
    expect(result.found).toBe(false);
    expect(result.error).toBe('multiple_matches');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/quote-engine-refinements.test.js`
Expected: FAIL — `findProducts('mat', ['desktop'])` ignores the second argument, so the boost/exclude assertions fail. (If the "no refinements" regression test also fails, STOP: the baseline changed — investigate before proceeding.)

- [ ] **Step 3: Implement refinement handling**

In `pricing/quote-engine.js`, add after the `scoreMatch` function (after line 134):

```js
// ─────────────────────────────────────────────────────────────────────
// Refinement application (LLM-first intent, 2026-07-05 spec)
// ─────────────────────────────────────────────────────────────────────
// Positive refinements ('desktop', 'a5') boost candidates whose name
// contains the token (stemmed) by +25 — enough to clear the <20 ambiguity
// window when only one candidate matches, but capped at 99 so a boost can
// never fake an exact-match score of 100. Negative refinements ('!yoga')
// exclude candidates entirely. Empty refinements → candidates unchanged.
const REFINEMENT_BOOST = 25;

function productNameTokens(productName) {
  return new Set(
    productName.toLowerCase().split(/[\s/&\-,.]+/)
      .filter(t => t.length >= 2)
      .map(stem)
  );
}

function applyRefinements(candidates, refinements) {
  if (!Array.isArray(refinements) || refinements.length === 0) return candidates;

  const positive = [];
  const negative = [];
  for (const r of refinements) {
    if (typeof r !== 'string') continue;
    const t = r.trim().toLowerCase();
    if (!t) continue;
    if (t.startsWith('!')) {
      const tok = t.slice(1).trim();
      if (tok) negative.push(stem(tok));
    } else {
      positive.push(...t.split(/\s+/).filter(x => x.length >= 2).map(stem));
    }
  }

  return candidates
    .filter(c => {
      const tokens = productNameTokens(c.name);
      return !negative.some(n => tokens.has(n));
    })
    .map(c => {
      const tokens = productNameTokens(c.name);
      const hits = positive.filter(p => tokens.has(p)).length;
      if (hits === 0 || c.score >= 100) return c;
      return { ...c, score: Math.min(c.score + hits * REFINEMENT_BOOST, 99) };
    })
    .sort((a, b) => b.score - a.score);
}
```

Change the `findProducts` signature (line 137) and its return (line 157):

```js
// Find products matching the query, sorted by score desc.
// refinements: optional narrowing terms from the intent resolver.
function findProducts(query, refinements = []) {
```

and replace the final two lines of the function:

```js
  candidates.sort((a, b) => b.score - a.score);
  return applyRefinements(candidates, refinements);
```

Change the `computeQuote` destructuring (line 172) and the `findProducts` call (line 185):

```js
function computeQuote({ productQuery, quantity, customerType, branding, refinements }) {
```

```js
  const matches = findProducts(productQuery, refinements);
```

Everything else in `computeQuote` — including the ambiguity rule at lines 190-199 — stays untouched.

- [ ] **Step 4: Run the new tests AND the full existing suite**

Run: `npx jest tests/quote-engine-refinements.test.js`
Expected: PASS, 7 tests

Run: `npx jest`
Expected: PASS — every pre-existing quote/pricing test must still pass (the `refinements: []` path is byte-identical). If any pricing test fails, the regression guard was violated — fix before committing.

- [ ] **Step 5: Commit**

```bash
git add pricing/quote-engine.js tests/quote-engine-refinements.test.js
git commit -m "feat: refinement-aware product selection in quote engine"
```

---

### Task 4: Rewire `server.js`

**Files:**
- Modify: `server.js:17` (imports), `server.js:20-21` (remove disambiguator import), `server.js:2793-2816` (resolver call + remove classifier patch block), `server.js:2827-2900` (confidence gate + replace disambiguator block), `server.js:3286` region (`/stats`)

**Interfaces:**
- Consumes: `resolveIntent(currentMessage, contextMessages, {budgetMs})` and `getResolverStats()` from Task 2; refinement-aware `computeQuote` from Task 3 (the intent object already carries `refinements`, so `computeQuote(intent)` picks them up with no further change)
- Produces: no new exports; behavioral contract is "one resolver call per turn, no disambiguator, low-confidence turns ask instead of quote"

- [ ] **Step 1: Update imports**

Replace line 17:

```js
const { extractIntent: extractPricingIntent } = require('./pricing/intent-extractor');
```

with:

```js
// LLM-first intent resolution (2026-07-05 spec). Regex extractor is now the
// resolver's internal fallback — server.js no longer calls it directly.
const { resolveIntent, getResolverStats } = require('./pricing/intent-resolver');
```

Delete the v61.2 disambiguator import (the two lines added just after, currently):

```js
// v61.2 — LLM-based product disambiguator (filters candidate SKUs by conversation refinements)
const { disambiguateProducts } = require('./pricing/llm-disambiguator');
```

- [ ] **Step 2: Replace the extraction call and remove the classifier patch block**

At line 2796, replace:

```js
      intent = extractPricingIntent(sanitizedMessage, context);
```

with:

```js
      // ONE LLM pass per turn extracts the full intent (product, refinements,
      // quantity, customer type, branding). Regex fallback + telemetry flag
      // live inside the resolver. 3s wall-clock budget on the interactive path.
      intent = await resolveIntent(sanitizedMessage, context, { budgetMs: 3000 });
```

Delete the now-redundant classifier patch block at lines 2807-2816 (the resolver supplies `customerType` directly; `deriveStateAsync` short-circuits at `conversation-state.js:351` when it's present):

```js
        // If the LLM classifier resolved customer type that the regex missed,
        // patch the intent object so the engine routing (a few lines below)
        // also sees it. This is what lets us actually fire the verified quote
        // when the regex would have left us stuck at AWAITING_CUSTOMER_TYPE.
        if (intent && derivedState?.llmClassification &&
            derivedState.llmClassification.customerType !== 'unknown' &&
            !intent.customerType) {
          intent.customerType = derivedState.llmClassification.customerType;
          console.log(`🧠 LLM classifier resolved customerType=${intent.customerType} (${derivedState.llmClassification.reasoning})`);
        }
```

- [ ] **Step 3: Add the confidence gate and replace the disambiguator block**

Immediately after `if (intent) {` (line 2827), insert the gate:

```js
      if (intent) {
        // Confidence gate (llm source only): below 0.6 the extraction is too
        // uncertain to quote from — ask a clarifying question instead. The
        // extraction still flowed into state derivation above, so the next
        // turn benefits. Regex fallback carries confidence 1.0 by design.
        if (intent.source === 'llm' && intent.confidence < 0.6) {
          const block = [
            '[PRICING — UNCERTAIN INTENT]:',
            'The customer may want a quote but their request is unclear.',
            'Ask ONE friendly clarifying question about what they need. Do NOT quote any price yet.'
          ].join('\n');
          augmentedMessage = `${contextAwareMessage}\n\n${block}`;
          console.log(`💰 Low-confidence intent (${intent.confidence}) — asking instead of quoting`);
        } else if (intent.productQuery && intent.quantity && intent.customerType) {
```

(The former `if (intent.productQuery && intent.quantity && intent.customerType) {` becomes the `else if` above. The trailing `} else if (intent.productQuery || intent.quantity) {` missing-info branch at line 2919 is unchanged.)

Replace the ENTIRE v61.2 `multiple_matches` branch (lines 2844-2900, everything from `} else if (quote.error === 'multiple_matches'` down to the closing brace before `} else if (quote.error === 'product_not_found')`) with the simple names-only block — refinements have already narrowed inside the engine, so anything still ambiguous is genuinely ambiguous:

```js
          } else if (quote.error === 'multiple_matches' && quote.matches?.length) {
            // Refinements were already applied inside the engine; whatever is
            // still ambiguous needs a human choice. Names only — engine knows
            // MRPs, the LLM doesn't need to.
            const block = [
              '[PRODUCT AMBIGUOUS — ask the customer which specific product they want]:',
              'Catalog matches for their query:',
              ...quote.matches.slice(0, 6).map(m => `- ${m.name}`),
              'Do NOT quote a price yet. Ask the customer to choose one of the above options.'
            ].join('\n');
            augmentedMessage = `${contextAwareMessage}\n\n${block}`;
            console.log(`💰 Product ambiguous for "${intent.productQuery}" — ${quote.matches.length} matches after refinements`);
```

- [ ] **Step 4: Expose resolver stats on `/stats`**

In the `app.get('/stats', ...)` handler (line 3286), add one key to the JSON response object it builds:

```js
      intentResolver: getResolverStats(),
```

(Place it alongside the other top-level stats keys in the response object literal.)

- [ ] **Step 5: Syntax check + full suite**

Run: `node --check server.js`
Expected: no output (parses cleanly)

Run: `npx jest`
Expected: PASS — `tests/llm-disambiguator.test.js` still passes because the module still exists (deleted in Task 6); no other suite touches the modified region.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: server uses LLM-first intent resolver; drops disambiguator wiring; confidence gate + /stats counter"
```

---

### Task 5: Office-mats regression test (the motivating bug)

**Files:**
- Test: `tests/office-mats-regression.test.js`

**Interfaces:**
- Consumes: `resolveIntent` (Task 2, with `callGroqJson` mocked), `computeQuote` (Task 3, real catalog). This is the resolver→engine chain — the exact path `server.js` now runs, minus Express.

- [ ] **Step 1: Write the test**

Create `tests/office-mats-regression.test.js`:

```js
// Regression test for the motivating bug (spec 2026-07-05):
//   customer: "I need 200 mats for office" → bot lists 3 mats
//   customer: "for office work desktop mats are better right" → bot agrees
//   customer: "what are the other options?" → OLD bot forgot the refinement
//                                             and listed all 3 mats again.
// With LLM-first extraction the refinement survives because it is re-derived
// from the conversation window every turn, and the engine turns it into a
// single decisive match.

jest.mock('../pricing/groq-client', () => ({
  callGroqJson: jest.fn(),
  DEFAULT_BUDGET_MS: 3000
}));
const { callGroqJson } = require('../pricing/groq-client');
const { resolveIntent } = require('../pricing/intent-resolver');
const { computeQuote } = require('../pricing/quote-engine');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

const CONVERSATION = [
  { role: 'user', content: 'i need 200 mats for office, for my own use' },
  { role: 'assistant', content: 'We have Coffee Mat, Rubberized Desktop Mat, Yoga Mat — which one?' },
  { role: 'user', content: 'for office work desktop mats are better right' },
  { role: 'assistant', content: 'Yes, desktop mats are a great choice for office use!' }
];

test('refinement survives the "other options" turn and yields a single desktop-mat quote', async () => {
  // What the LLM extracts from the full window on the "other options" turn —
  // the refinement is still visible in the conversation, so it stays extracted.
  callGroqJson.mockResolvedValue({
    productQuery: 'mat',
    refinements: ['desktop', 'office'],
    quantity: 200,
    customerType: 'end_consumer',
    branding: null,
    confidence: 0.9,
    reasoning: 'desktop mats for own office use; refinement retained'
  });

  const intent = await resolveIntent('what are the other options?', CONVERSATION);

  expect(intent.refinements).toContain('desktop');

  const quote = computeQuote(intent);

  // The OLD pipeline returned multiple_matches here (the loop). Now the
  // refinement makes the engine decisive.
  expect(quote.found).toBe(true);
  expect(quote.product.name.toLowerCase()).toContain('desktop');
  expect(quote.quantity).toBe(200);
  expect(quote.grandTotal).toBeGreaterThan(0);
});

test('without the refinement the same query is still ambiguous (sanity check)', () => {
  const quote = computeQuote({
    productQuery: 'mat', quantity: 200, customerType: 'end_consumer', refinements: []
  });
  expect(quote.found).toBe(false);
  expect(quote.error).toBe('multiple_matches');
});
```

- [ ] **Step 2: Run the test**

Run: `npx jest tests/office-mats-regression.test.js`
Expected: PASS, 2 tests (Tasks 2 and 3 already landed, so this passes immediately — it exists as a permanent regression pin, not as TDD scaffolding)

- [ ] **Step 3: Run the entire suite**

Run: `npx jest`
Expected: PASS across all suites

- [ ] **Step 4: Commit**

```bash
git add tests/office-mats-regression.test.js
git commit -m "test: pin office-mats refinement-loss regression (resolver→engine)"
```

---

### Task 6: Retire the rescue layers + rollout config

**Files:**
- Delete: `pricing/llm-disambiguator.js`, `pricing/llm-classifier.js`, `tests/llm-disambiguator.test.js`
- Modify: `pricing/conversation-state.js:333-391` (deriveStateAsync), `render.yaml`, `.env.example`

**Interfaces:**
- Consumes: nothing new
- Produces: `deriveStateAsync(conversation, currentIntent, phone)` keeps its exact signature (server.js:2805 calls it) but becomes a thin async wrapper over `deriveState` — customer type now always arrives via the resolver's intent, so the classifier branch is dead code.

**Deploy-sequencing note:** the spec's rollout section says deletion is the LAST step, after the deploy is observed stable. If executing this plan pre-deploy, still do this task (the kill-switch `INTENT_RESOLVER=regex` remains the instant-rollback path — it restores regex extraction, which never needed the classifier patch block that was already removed in Task 4). If the operator prefers to observe production first, pause before this task; everything through Task 5 is deployable.

- [ ] **Step 1: Simplify `deriveStateAsync`**

In `pricing/conversation-state.js`, replace the whole function body (lines 338-391) with:

```js
// Async state derivation. Since the LLM-first intent resolver (2026-07-05
// spec) supplies customerType directly on the intent, the old LLM-classifier
// fallback branch is dead code — deriveState alone is sufficient. The async
// signature is kept so server.js call sites don't change.
async function deriveStateAsync(conversation, currentIntent = null, phone = null) { // eslint-disable-line no-unused-vars
  return deriveState(conversation, currentIntent);
}
```

- [ ] **Step 2: Delete the retired modules and their tests**

```bash
git rm pricing/llm-disambiguator.js pricing/llm-classifier.js tests/llm-disambiguator.test.js
```

Then verify nothing still references them:

Run: `grep -rn "llm-disambiguator\|llm-classifier" --include="*.js" . --exclude-dir=node_modules --exclude-dir=.claude`
Expected: no matches in source files (docs/*.md mentions are fine)

- [ ] **Step 3: Add the kill-switch to deployment config**

In `render.yaml`, add under the service's `envVars:` list:

```yaml
      - key: INTENT_RESOLVER
        value: llm  # set to "regex" to instantly revert to pre-LLM extraction
```

In `.env.example`, add:

```
# Intent extraction mode: llm (default, LLM-first) | regex (fallback-only, kill-switch)
INTENT_RESOLVER=llm
```

- [ ] **Step 4: Full suite + syntax check**

Run: `node --check server.js && node --check pricing/conversation-state.js`
Expected: no output

Run: `npx jest`
Expected: PASS — conversation-state tests that exercised the classifier branch may need their expectations updated to the sync-derivation result; if any test explicitly asserts `llmClassification` on the result, delete that assertion (the field no longer exists by design).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: retire llm-classifier + llm-disambiguator; add INTENT_RESOLVER kill-switch"
```

---

## Verification (post-plan)

1. `npx jest` — full suite green.
2. `INTENT_RESOLVER=regex npx jest tests/intent-resolver.test.js` — kill-switch path green.
3. Manual replay: walk the office-mats conversation against a local server (`npm run dev` + `test-webhook.js` or WhatsApp sandbox) and confirm the "what are the other options?" turn stays on desktop mats.
4. After deploy: watch `/stats → intentResolver.regexFallback`. A rising ratio of `regexFallback:llm` means Groq trouble; sustained problems → set `INTENT_RESOLVER=regex` on Render.

## Self-Review Notes

- **Spec coverage:** intent contract → Task 2; refinement-aware engine → Task 3; every-turn resolver + confidence gate + telemetry → Task 4; office-mats regression → Task 5; retirement + kill-switch + rollout → Task 6; shared plumbing dedup → Task 1. Error-handling spec items: budget (Task 1), per-field validation (Task 2), fallback+flag (Task 2/4), hallucination-by-construction (no task needed — LLM never sees catalog anywhere in this plan), low-confidence gate (Task 4).
- **Type consistency:** `resolveIntent` returns `refinements` (plural, lowercase array) consumed by `computeQuote({..., refinements})` — names match across Tasks 2/3/4/5. `getResolverStats()` used in Tasks 2 and 4 with the same name. `callGroqJson(messages, {budgetMs})` identical in Tasks 1, 2, and both mocks (Tasks 2, 5).
- **Known judgment call:** regex fallback reports `confidence: 1.0` so outages preserve today's quoting behavior (user decision: keep quoting through outage). The gate therefore only constrains the LLM path.
