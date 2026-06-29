// Catalog-aware vision identification — v60
//
// Uses Gemini 2.0 Flash (multimodal) to ACTUALLY LOOK at customer photos and
// identify the product against the live catalog. Replaces the hash/cloud-API
// matcher's brittle classification with proper visual reasoning.
//
// The prompt embeds your real catalog categories + their key products, so
// Gemini can disambiguate "this is a cork diary" vs "this is a leather diary"
// vs "this isn't even a cork product" — far more accurate than tag-based
// matchers for nuanced cork products.
//
// Output is strict JSON, so the bot can either:
//   - Quote confidently if cork product identified with high confidence
//   - Ask for clarification if uncertain
//   - Escalate via RULE G if the item exists but isn't in our catalog
//   - Politely decline if it's not a cork product at all

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// v60.1: Switched from gemini-2.0-flash (no free tier — 429 RESOURCE_EXHAUSTED)
// to gemini-2.5-flash, which has a working free tier and better vision accuracy.
// Verified by hitting both models with a test image — 2.0-flash returns 429,
// 2.5-flash returns valid JSON.
const GEMINI_VISION_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const FALLBACK_VISION_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';
const PRICING_FILE = path.join(__dirname, '..', 'data', 'pricing.json');

function collectGeminiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let i = 2; i <= 20; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

// Build a compact catalog summary the vision LLM can use to match products
let _catalogSummaryCache = null;
let _catalogSummaryCachedAt = 0;
const CATALOG_SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;

function getCatalogSummary() {
  if (_catalogSummaryCache && Date.now() - _catalogSummaryCachedAt < CATALOG_SUMMARY_TTL_MS) {
    return _catalogSummaryCache;
  }
  try {
    if (!fs.existsSync(PRICING_FILE)) return '';
    const data = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf-8'));
    const lines = [];
    const byCategory = {};
    for (const p of [...(data.horeca || []), ...(data.catalogue || [])]) {
      const cat = (p.category || 'OTHER').toLowerCase();
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(p.name);
    }
    for (const [cat, names] of Object.entries(byCategory)) {
      lines.push(`${cat}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}`);
    }
    _catalogSummaryCache = lines.join('\n');
    _catalogSummaryCachedAt = Date.now();
    return _catalogSummaryCache;
  } catch (e) {
    return '';
  }
}

const IDENTIFICATION_PROMPT = `You are a product identification expert for 9 Cork Sustainable Products, an Indian cork-products manufacturer.

A customer just sent a photo. Look at the image carefully and identify what product is shown.

Our catalog contains ONLY these product categories (cork-based items):
{{CATALOG_SUMMARY}}

Analyze the image and respond with STRICT JSON only (no markdown, no preamble):
{
  "visible_object": "what you literally see in the photo, in 5-10 words",
  "is_cork_product": true/false,
  "matched_category": "one of our catalog categories, or null if no match",
  "matched_product_name": "specific SKU name from our catalog if you can identify it, or null",
  "confidence": 0.0-1.0,
  "reasoning": "one-sentence explanation"
}

Confidence guide:
- 0.9+ : Specific catalog SKU clearly visible (e.g. an A5 cork diary with our typical design)
- 0.7-0.9 : Cork product, category clear, specific SKU uncertain
- 0.4-0.7 : Could be a cork product but not sure, or category ambiguous
- <0.4 : Doesn't look like a cork product, or photo too unclear

CRITICAL — be honest about uncertainty:
- If image shows a keychain, return is_cork_product: false (we don't sell keychains)
- If image is blurry or partial, lower confidence
- If image shows a non-cork item (leather wallet, plastic mug), is_cork_product: false
- Never guess a specific catalog SKU unless you can clearly see distinctive features matching it`;

async function callGeminiVision(imageBase64, mimeType, prompt, apiKey, useUrl = GEMINI_VISION_URL) {
  const response = await axios.post(
    `${useUrl}?key=${apiKey}`,
    {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: imageBase64 } }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 500,
        responseMimeType: 'application/json'
      }
    },
    { timeout: 15000 }
  );
  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Empty response from Gemini Vision');
  return JSON.parse(text);
}

/**
 * Identify a product from a customer-sent image using catalog-aware Gemini Vision.
 * @param {Buffer} imageBuffer
 * @param {string} mimeType (e.g. 'image/jpeg')
 * @returns {Promise<{
 *   visibleObject: string,
 *   isCorkProduct: boolean,
 *   matchedCategory: string | null,
 *   matchedProductName: string | null,
 *   confidence: number,
 *   reasoning: string
 * } | null>}
 */
async function identifyProductFromImage(imageBuffer, mimeType = 'image/jpeg') {
  const keys = collectGeminiKeys();
  if (keys.length === 0) {
    console.warn('⚠️ No GEMINI_API_KEY for vision identification');
    return null;
  }

  const prompt = IDENTIFICATION_PROMPT.replace('{{CATALOG_SUMMARY}}', getCatalogSummary());
  const imageBase64 = imageBuffer.toString('base64');

  // Try each key on the primary model first; if a key is rate-limited (429),
  // fall through to the next key. If ALL keys fail on the primary model,
  // try gemini-2.5-flash-lite as a secondary model with the first key.
  const errors = [];
  const maxAttempts = Math.min(keys.length, 9);

  // Phase 1: try gemini-2.5-flash with each available key
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await callGeminiVision(imageBase64, mimeType, prompt, keys[i], GEMINI_VISION_URL);
      console.log(`✅ Gemini Vision (2.5-flash) succeeded on key #${i + 1}`);
      return {
        visibleObject: result.visible_object || result.visibleObject || '',
        isCorkProduct: !!(result.is_cork_product ?? result.isCorkProduct),
        matchedCategory: result.matched_category || result.matchedCategory || null,
        matchedProductName: result.matched_product_name || result.matchedProductName || null,
        confidence: Number(result.confidence) || 0,
        reasoning: result.reasoning || ''
      };
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message || err.message;
      errors.push(`key#${i + 1} (2.5-flash, ${status || 'no-status'}): ${msg.substring(0, 100)}`);
    }
  }

  // Phase 2: ALL primary attempts failed — try the lighter model
  console.warn(`⚠️ All ${maxAttempts} keys failed on 2.5-flash — trying 2.5-flash-lite as fallback`);
  for (let i = 0; i < Math.min(keys.length, 3); i++) {
    try {
      const result = await callGeminiVision(imageBase64, mimeType, prompt, keys[i], FALLBACK_VISION_URL);
      console.log(`✅ Gemini Vision (2.5-flash-lite fallback) succeeded on key #${i + 1}`);
      return {
        visibleObject: result.visible_object || result.visibleObject || '',
        isCorkProduct: !!(result.is_cork_product ?? result.isCorkProduct),
        matchedCategory: result.matched_category || result.matchedCategory || null,
        matchedProductName: result.matched_product_name || result.matchedProductName || null,
        confidence: Number(result.confidence) || 0,
        reasoning: result.reasoning || ''
      };
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message || err.message;
      errors.push(`key#${i + 1} (2.5-flash-lite, ${status || 'no-status'}): ${msg.substring(0, 100)}`);
    }
  }

  // EVERYTHING failed — log detailed errors so the operator knows why
  console.error(`❌ Gemini Vision ALL ATTEMPTS FAILED:`);
  errors.forEach(e => console.error(`   ${e}`));
  return null;
}

module.exports = { identifyProductFromImage };
