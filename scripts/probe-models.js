#!/usr/bin/env node
// Verifies that every model id in config/models.js exists at its provider.
// Run at boot (server.js) and from the CLI. The health endpoint used to
// report key COUNTS, which stayed "ok" through a 100% outage caused by
// retired models; this checks the thing that actually fails.
//
// Checks EVERY configured key per provider, not just the first. Render's
// first GEMINI_API_KEY went invalid in production (HTTP 400 "API key not
// valid") while keys 2-9 were fine, so checking only env.GEMINI_API_KEY
// reported a false outage. A provider is "reachable" if at least one of
// its keys lists models; an invalid key is recorded in `errors` by index
// only — the key itself is never logged or returned.
const { MODELS, GROQ_MODELS_URL, GEMINI_MODELS_URL, ANTHROPIC_MODELS_URL } = require('../config/models');

const GROQ_SLOTS = ['GROQ_CHAT', 'GROQ_FAST', 'GROQ_JSON', 'GROQ_WHISPER'];
const GEMINI_SLOTS = ['GEMINI_CHAT', 'GEMINI_VISION', 'GEMINI_VISION_LITE'];
const ANTHROPIC_SLOTS = ['CLAUDE_FALLBACK'];

const MAX_ERROR_MESSAGE_LENGTH = 120;

// Same env-var ranges ai-provider-manager.js uses to build its key lists.
function collectKeys(env, baseName, maxIndex) {
  const keys = [];
  if (env[baseName]) keys.push(env[baseName]);
  for (let i = 2; i <= maxIndex; i++) {
    const key = env[`${baseName}_${i}`];
    if (key) keys.push(key);
  }
  return keys;
}

// Lists models for a single key. Throws on a non-200 response with the
// provider's error message (never the key) so the caller can record
// "<provider> key#<n>: <message>" without echoing key material.
async function listGroqKey(fetchImpl, key) {
  const r = await fetchImpl(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${key}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `HTTP ${r.status}`);
  return new Set((body.data || []).map(m => m.id));
}

async function listGeminiKey(fetchImpl, key) {
  const r = await fetchImpl(`${GEMINI_MODELS_URL}?key=${key}&pageSize=200`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `HTTP ${r.status}`);
  return new Set((body.models || []).map(m => String(m.name).replace(/^models\//, '')));
}

async function listAnthropicKey(fetchImpl, key) {
  const r = await fetchImpl(`${ANTHROPIC_MODELS_URL}?limit=1000`, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `HTTP ${r.status}`);
  return new Set((body.data || []).map(m => m.id));
}

async function probeModels({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const result = { ok: true, missing: [], checked: [], errors: [], keys: {} };
  const providers = [
    { name: 'groq', keys: collectKeys(env, 'GROQ_API_KEY', 10), slots: GROQ_SLOTS, list: listGroqKey },
    { name: 'gemini', keys: collectKeys(env, 'GEMINI_API_KEY', 20), slots: GEMINI_SLOTS, list: listGeminiKey },
    { name: 'anthropic', keys: collectKeys(env, 'ANTHROPIC_API_KEY', 1), slots: ANTHROPIC_SLOTS, list: listAnthropicKey },
  ];

  for (const p of providers) {
    const total = p.keys.length;
    let valid = 0;
    const available = new Set();

    for (let i = 0; i < total; i++) {
      try {
        const ids = await p.list(fetchImpl, p.keys[i]);
        valid++;
        for (const id of ids) available.add(id);
      } catch (err) {
        const message = String(err.message || '').slice(0, MAX_ERROR_MESSAGE_LENGTH);
        result.errors.push(`${p.name} key#${i + 1}: ${message}`);
      }
    }

    result.keys[p.name] = { total, valid };
    if (total === 0) continue; // no key configured — nothing to check

    if (valid === 0) result.ok = false;

    for (const slot of p.slots) {
      const id = MODELS[slot];
      result.checked.push(`${p.name}:${slot}=${id}`);
      if (!available.has(id)) {
        result.ok = false;
        result.missing.push(`${p.name}:${slot}=${id}`);
      }
    }
  }

  result.checkedAt = new Date().toISOString();
  return result;
}

module.exports = { probeModels };

if (require.main === module) {
  require('dotenv').config();
  probeModels().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}
