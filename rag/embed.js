// Gemini embedding wrapper. Uses gemini-embedding-001 truncated to 768 dimensions
// to match Pinecone index. Free tier: ~1500 RPM. Returns null on failure (caller handles fallback).

const axios = require('axios');

const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const OUTPUT_DIMS = 768;

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
      { content: { parts: [{ text }] }, outputDimensionality: OUTPUT_DIMS },
      { timeout: 5000 }
    );
    const values = response.data?.embedding?.values;
    if (!Array.isArray(values) || values.length !== OUTPUT_DIMS) {
      console.warn('⚠️ Unexpected embedding response shape (got ' + (values?.length || 0) + ' dims)');
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
