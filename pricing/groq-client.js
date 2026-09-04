// Shared Groq JSON client — single source of truth for the Groq REST plumbing
// that was previously copy-pasted across llm-classifier.js and
// llm-disambiguator.js: key collection, multi-key failover, and the
// wall-clock budget introduced in v61.2.
//
// Contract: callGroqJson(messages, options) returns the model's parsed JSON
// object, or null when the LLM is unavailable (no keys, budget spent, or all
// keys failed). It NEVER throws — callers branch on null and degrade.

const axios = require('axios');
const { MODELS } = require('../config/models');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = MODELS.GROQ_JSON;

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
