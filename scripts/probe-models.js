#!/usr/bin/env node
// Verifies that every model id in config/models.js exists at its provider.
// Run at boot (server.js) and from the CLI. The health endpoint used to
// report key COUNTS, which stayed "ok" through a 100% outage caused by
// retired models; this checks the thing that actually fails.
const { MODELS, GROQ_MODELS_URL, GEMINI_MODELS_URL } = require('../config/models');

const GROQ_SLOTS = ['GROQ_CHAT', 'GROQ_FAST', 'GROQ_JSON', 'GROQ_WHISPER'];
const GEMINI_SLOTS = ['GEMINI_CHAT', 'GEMINI_VISION', 'GEMINI_VISION_LITE'];

async function listGroq(fetchImpl, key) {
  const r = await fetchImpl(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return new Set((d.data || []).map(m => m.id));
}

async function listGemini(fetchImpl, key) {
  const r = await fetchImpl(`${GEMINI_MODELS_URL}?key=${key}&pageSize=200`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return new Set((d.models || []).map(m => String(m.name).replace(/^models\//, '')));
}

async function probeModels({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const result = { ok: true, missing: [], checked: [], errors: [] };
  const providers = [
    { name: 'groq', key: env.GROQ_API_KEY, slots: GROQ_SLOTS, list: listGroq },
    { name: 'gemini', key: env.GEMINI_API_KEY, slots: GEMINI_SLOTS, list: listGemini },
  ];
  for (const p of providers) {
    if (!p.key) continue;
    let available;
    try {
      available = await p.list(fetchImpl, p.key);
    } catch (err) {
      result.ok = false;
      result.errors.push(`${p.name}: ${err.message}`);
      continue;
    }
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
