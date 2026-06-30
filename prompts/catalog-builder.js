// Generates the catalog section of the system prompt from data/pricing.json.
//
// v61 (Single-Brain): catalog injected into prompt shows ONLY product names +
// categories, NO MRP/prices. The deterministic pricing engine
// (pricing/quote-engine.js) is the sole source for prices.
//
// Why: when prices appeared in the prompt, the LLM treated them as fair game
// to quote/compare/calculate from — leading to MRP exposure, discount-math
// hallucinations, and contradictions with the engine. Removing prices from
// the prompt makes the LLM physically incapable of those leaks.
//
// Cache: 6h, invalidated explicitly by the daily pricing sync cron.

const fs = require('fs');
const path = require('path');

const PRICING_FILE = path.join(__dirname, '..', 'data', 'pricing.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cachedData = null;
let cachedAt = 0;

function invalidateCache() {
  cachedData = null;
  cachedAt = 0;
}

function loadPricing() {
  if (cachedData && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedData;
  }
  try {
    if (!fs.existsSync(PRICING_FILE)) return null;
    const raw = fs.readFileSync(PRICING_FILE, 'utf-8');
    cachedData = JSON.parse(raw);
    cachedAt = Date.now();
    return cachedData;
  } catch (err) {
    console.warn('⚠️ pricing.json load failed:', err.message);
    return null;
  }
}

// Group products by category and return a compact name-only list.
// Cap names per category so the prompt stays small.
function formatNamesByCategory(products, getName, getCategory, header, maxPerCat = 8) {
  if (!products || products.length === 0) return '';
  const byCategory = {};
  for (const p of products) {
    const name = getName(p);
    const cat = getCategory(p);
    if (!name || !cat) continue;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(name);
  }
  if (Object.keys(byCategory).length === 0) return '';
  const lines = [header];
  for (const [cat, names] of Object.entries(byCategory)) {
    if (cat === 'OTHER') continue;
    const sample = names.slice(0, maxPerCat).join('; ');
    lines.push(`  • ${cat}: ${sample}${names.length > maxPerCat ? '; …' : ''}`);
  }
  return lines.join('\n');
}

function buildCatalogSection() {
  const data = loadPricing();
  if (!data) {
    return `Product catalog data is not loaded right now. If a customer asks about specific products, qualify their needs and the engine will surface the correct SKU when available.`;
  }

  const horeca = formatNamesByCategory(
    data.horeca,
    p => p.name,
    p => p.category,
    '🍽️ HORECA & wholesale catalog products:'
  );

  const catalogue = formatNamesByCategory(
    data.catalogue,
    p => p.name,
    p => p.category,
    '🟤 Gifting catalogue products:'
  );

  const trophies = (data.trophies || []).length > 0
    ? `🏆 Trophy catalogue: ${data.trophies.length} trophy designs available (sent as PDF on request).`
    : '';

  const combos = (data.combos || []).length > 0
    ? `🎁 Gifting combos: ${data.combos.length} bundled combos available (sent as PDF on request).`
    : '';

  const parts = [
    `Live catalog (synced ${data.syncedAt?.split('T')[0] || 'unknown'}).`,
    'These are the product names we sell. The pricing engine handles all prices —',
    'you never need to look up or recall prices yourself. If a customer asks',
    'about a specific product, the engine will inject a [VERIFIED QUOTE] block',
    'when ready. If the engine indicates the product is not in catalog, escalate via RULE G.',
    '',
    catalogue,
    '',
    horeca,
    '',
    trophies,
    combos
  ].filter(Boolean);

  return parts.join('\n');
}

module.exports = { buildCatalogSection, loadPricing, invalidateCache };
