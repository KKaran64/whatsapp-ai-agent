// Gemini embedding wrapper. Uses gemini-embedding-001 truncated to 1024 dims
// to match Pinecone index. Free tier: ~1500 RPM per key.
// Tries GEMINI_API_KEY, then GEMINI_API_KEY_2 through _20 if the primary fails.
// Returns null only if ALL keys fail.

const axios = require('axios');

const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const OUTPUT_DIMS = 1024;

function collectKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let i = 2; i <= 20; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

async function tryEmbed(text, key) {
  const response = await axios.post(
    `${EMBED_URL}?key=${key}`,
    { content: { parts: [{ text }] }, outputDimensionality: OUTPUT_DIMS },
    { timeout: 5000 }
  );
  const values = response.data?.embedding?.values;
  if (!Array.isArray(values) || values.length !== OUTPUT_DIMS) {
    throw new Error('Unexpected response shape (got ' + (values?.length || 0) + ' dims)');
  }
  return values;
}

async function embedText(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  const keys = collectKeys();
  if (keys.length === 0) {
    console.warn('⚠️ No GEMINI_API_KEY found — embedding skipped');
    return null;
  }

  const errors = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      return await tryEmbed(text, keys[i]);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      errors.push(`key#${i + 1}: ${msg.substring(0, 80)}`);
      // Continue to next key
    }
  }
  console.error('❌ All ' + keys.length + ' Gemini keys failed:', errors.join(' | '));
  return null;
}

async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    const vec = await embedText(text);
    results.push(vec);
    // Rate limit pacing: 1500 RPM = ~40ms between calls
    await new Promise(r => setTimeout(r, 50));
  }
  return results;
}

module.exports = { embedText, embedBatch };
