// Generates the catalog section of the system prompt from data/pricing.json.
// Falls back to a minimal hardcoded note if pricing.json is missing or stale.
//
// Cached in-memory to avoid disk I/O on every message. Cache TTL: 60 seconds
// (so cron-refreshed prices propagate without server restart).

const fs = require('fs');
const path = require('path');

const PRICING_FILE = path.join(__dirname, '..', 'data', 'pricing.json');
// v58: TTL bumped to 6h — the pricing cron only refreshes daily anyway, so 60s
// was wasting disk I/O on every message. The cron explicitly invalidates the cache.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function invalidateCache() {
  cachedData = null;
  cachedAt = 0;
}

let cachedData = null;
let cachedAt = 0;

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

// Group HORECA products by category, return a compact table-ish string.
//
// IMPORTANT: We deliberately do NOT show bulkPrice in the catalog. The discount
// slabs already encode the reseller 40%-off-MRP cap, which lands at bulkPrice
// mathematically. Showing "(bulk floor: ₹X)" misled the LLM into reading "bulk"
// as "the price for bulk orders" — causing it to use bulkPrice as the discount
// base instead of mrpPrice. Discount math always starts from MRP per Scenario B.
function formatHoreca(products) {
  if (!products || products.length === 0) return '';
  const byCategory = {};
  for (const p of products) {
    if (!p.name || !p.mrpPrice) continue;
    const cat = p.category || 'OTHER';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }
  const lines = ['🍽️ **HORECA CATALOG (MRP — apply discount slabs from rules above):**'];
  for (const [cat, items] of Object.entries(byCategory)) {
    const top = items.slice(0, 8).map(p => `${p.name} MRP ₹${p.mrpPrice}`).join('; ');
    lines.push(`  • **${cat}**: ${top}`);
  }
  return lines.join('\n');
}

// Format gifting catalogue grouped by category (parsed from sheet section headers)
function formatCatalogue(products) {
  if (!products || products.length === 0) return '';
  const byCategory = {};
  for (const p of products) {
    if (!p.name || !p.price) continue;
    const cat = p.category || 'OTHER';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }
  const lines = ['🟤 **GIFTING CATALOG (MRP — apply discount slabs from rules above):**'];
  for (const [cat, items] of Object.entries(byCategory)) {
    if (!cat || cat === 'OTHER') continue;
    const top = items.slice(0, 10).map(p => `${p.name} ₹${p.price}`).join('; ');
    lines.push(`  • **${cat}**: ${top}`);
  }
  return lines.join('\n');
}

function formatTrophies(products) {
  if (!products || products.length === 0) return '';
  const lines = ['🏆 **TROPHY CATALOG (MRP — discount slabs apply):**'];
  for (const p of products.slice(0, 20)) {
    if (!p.name) continue;
    const code = p.productCode ? ` [${p.productCode}]` : '';
    lines.push(`  • ${p.name}${code} — ₹${p.price}`);
  }
  return lines.join('\n');
}

function formatCombos(combos) {
  if (!combos || combos.length === 0) return '';
  const lines = ['🎁 **GIFTING COMBOS (bundled — combo price already includes bundle savings):**'];
  for (const c of combos.slice(0, 30)) {
    if (!c.name) continue;
    const itemList = c.items.slice(0, 6).map(i => i.name).join(' + ');
    lines.push(`  • **${c.name}** ₹${c.comboPrice}: ${itemList}`);
  }
  return lines.join('\n');
}

function buildCatalogSection() {
  const data = loadPricing();
  if (!data) {
    return `═══════════════════════════════════════
📋 PRODUCT CATALOG
═══════════════════════════════════════

⚠️ Live pricing data unavailable. When asked for specific prices, say:
"Let me confirm exact pricing — what's the product, quantity, and end-consumer or reseller?"`;
  }

  const parts = [
    '═══════════════════════════════════════',
    `📋 LIVE PRODUCT CATALOG (synced ${data.syncedAt?.split('T')[0] || 'unknown'})`,
    '═══════════════════════════════════════',
    '',
    '⚠️ ALL prices are MRP per piece (excl. GST and shipping).',
    'Apply discount slabs from the rules section based on customer type (end consumer vs reseller).',
    '',
    formatCatalogue(data.catalogue),
    '',
    formatHoreca(data.horeca),
    '',
    formatTrophies(data.trophies),
    '',
    formatCombos(data.combos),
    '',
    '🔴 GST: 18% on Diaries / Metal Pen / Glass Bottle / branding service. 5% on all other cork products.'
  ];

  return parts.filter(Boolean).join('\n');
}

module.exports = { buildCatalogSection, loadPricing, invalidateCache };
