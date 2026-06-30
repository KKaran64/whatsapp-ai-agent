// LLM-based customer-type classifier — v61.1
//
// Replaces the brittle regex layer in conversation-state.js with a tiny Groq
// LLM call that classifies the customer's intent from conversation history.
//
// Why: regex breaks on typos ("comany"), paraphrases ("for my own thing"),
// code-switched Hindi-English ("apne use ke liye"), voice-transcription
// errors, and unusual phrasing. LLMs handle all of these natively because
// they understand language.
//
// Architecture:
//   - Single Groq call per uncertain turn (~200ms, free tier covers it)
//   - Strict JSON output: { customerType, confidence, reasoning }
//   - Multi-key failover (same pattern as audio-handler.js)
//   - Cached per phone for the session — we only classify once per
//     conversation (the classification doesn't change mid-conversation
//     unless the customer explicitly says it does)

const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

function collectGroqKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

const SYSTEM_PROMPT = `You are a customer-intent classifier for a cork products business (B2B + B2C).

Given the customer's messages, decide whether they are buying for their OWN USE or to RESELL onward.

Return ONLY a single JSON object with these exact keys:
  {"customerType": "end_consumer" | "reseller" | "unknown", "confidence": 0.0-1.0, "reasoning": "one sentence"}

Definitions:
  - "end_consumer" = buying for their OWN use. Includes: hotels, restaurants, cafes
    buying for their own venue; companies buying for corporate gifting, employees,
    or events; individuals buying for personal use; offices buying for own use.
  - "reseller" = buying to RESELL onward. Includes: gifting companies, retail
    shops, distributors, wholesalers, "I sell to my customers" / "for resale".
  - "unknown" = no clear signal yet (just product/quantity mentioned with no use case).

Handle typos and informal phrasing — "comany" = "company", "for my offc" = "for my office", etc.
Handle Hindi/Hinglish — "apne liye" / "apne use ke liye" = end_consumer.
If the customer's intent is ambiguous, return "unknown" with low confidence.

Examples:
  Customer: "i need 100 cork diaries for my comany event"
  → {"customerType": "end_consumer", "confidence": 0.95, "reasoning": "for their own company event"}

  Customer: "I run a gifting business, need 200 planters"
  → {"customerType": "reseller", "confidence": 0.98, "reasoning": "explicit 'gifting business' = reseller"}

  Customer: "hi do u have cork diaries"
  → {"customerType": "unknown", "confidence": 0.9, "reasoning": "no use-case signal yet"}

  Customer: "for my hotel"
  → {"customerType": "end_consumer", "confidence": 0.98, "reasoning": "buying for their own venue"}

Output ONLY the JSON object. No prose, no markdown.`;

async function callGroq(messages, apiKey) {
  const response = await axios.post(GROQ_URL, {
    model: MODEL,
    messages,
    temperature: 0.1,
    max_tokens: 200,
    response_format: { type: 'json_object' }
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 8000
  });
  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty Groq response');
  return JSON.parse(content);
}

/**
 * Classify a customer's intent from their conversation history.
 *
 * @param {string} customerText — concatenated recent customer messages (last 5 or so)
 * @returns {Promise<{customerType: 'end_consumer'|'reseller'|'unknown', confidence: number, reasoning: string} | null>}
 *          Returns null only if all Groq keys failed.
 */
async function classifyCustomerType(customerText) {
  if (!customerText || typeof customerText !== 'string' || customerText.trim().length === 0) {
    return { customerType: 'unknown', confidence: 0, reasoning: 'empty input' };
  }

  const keys = collectGroqKeys();
  if (keys.length === 0) {
    console.warn('⚠️ LLM classifier: no GROQ_API_KEY configured');
    return null;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Customer messages (concatenated):\n${customerText.substring(0, 1500)}` }
  ];

  const errors = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      const result = await callGroq(messages, keys[i]);
      const type = result.customerType;
      if (type !== 'end_consumer' && type !== 'reseller' && type !== 'unknown') {
        errors.push(`key#${i + 1}: invalid customerType '${type}'`);
        continue;
      }
      return {
        customerType: type,
        confidence: Number(result.confidence) || 0,
        reasoning: String(result.reasoning || '').substring(0, 200)
      };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      errors.push(`key#${i + 1}: ${msg.substring(0, 80)}`);
    }
  }
  console.warn(`⚠️ LLM classifier: all ${keys.length} keys failed: ${errors.join(' | ')}`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Per-phone session cache so we don't classify the same conversation twice
// ─────────────────────────────────────────────────────────────────────
// The classification only changes if the customer explicitly re-asserts.
// Cache keyed on phone, invalidated after 30 min of no new pricing intent.

const classifyCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function getCached(phone) {
  const entry = classifyCache.get(phone);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    classifyCache.delete(phone);
    return null;
  }
  return entry.result;
}

function setCached(phone, result) {
  classifyCache.set(phone, { result, cachedAt: Date.now() });
  // Cap cache size — evict oldest if > 500 phones
  if (classifyCache.size > 500) {
    const oldest = classifyCache.keys().next().value;
    classifyCache.delete(oldest);
  }
}

function invalidateCache(phone) {
  classifyCache.delete(phone);
}

/**
 * High-level: classify + cache. Returns the cached value if available,
 * otherwise classifies fresh and caches.
 */
async function classifyAndCache(phone, customerText) {
  const cached = getCached(phone);
  if (cached && cached.customerType !== 'unknown') {
    // Already classified confidently — reuse
    return { ...cached, fromCache: true };
  }
  const fresh = await classifyCustomerType(customerText);
  if (fresh && fresh.customerType !== 'unknown' && fresh.confidence >= 0.7) {
    setCached(phone, fresh);
  }
  return fresh;
}

module.exports = {
  classifyCustomerType,
  classifyAndCache,
  invalidateCache,
  // for testing
  _classifyCache: classifyCache
};
