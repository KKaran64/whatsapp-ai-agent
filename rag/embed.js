// Gemini embedding wrapper. Uses text-embedding-004 (768 dimensions).
// Free tier: 1500 RPM. Returns null on failure (caller handles fallback).

const axios = require('axios');

const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';

async function embedText(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn('⚠️ GEMINI_API_KEY missing — embedding skipped');
    return null;
  }

  try {
    const response = await axios.post(
      `${EMBED_URL}?key=${key}`,
      { content: { parts: [{ text }] } },
      { timeout: 5000 }
    );
    const values = response.data?.embedding?.values;
    if (!Array.isArray(values) || values.length !== 768) {
      console.warn('⚠️ Unexpected embedding response shape');
      return null;
    }
    return values;
  } catch (err) {
    console.error('❌ Embedding failed:', err.message);
    return null;
  }
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
