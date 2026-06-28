// Quote Engine — Path B (v60) deterministic pricing.
//
// Takes a structured intent { productQuery, quantity, customerType, branding }
// and returns a fully-computed, rounded quote drawn STRICTLY from data/pricing.json.
// The LLM does NOT compute prices anymore — it presents whatever this engine returns.
//
// This eliminates the hallucination class of bugs (phantom MRPs, wrong slabs,
// mis-applied GST, decimals, etc.) by making pricing a pure function of catalog data.

const fs = require('fs');
const path = require('path');

const PRICING_FILE = path.join(__dirname, '..', 'data', 'pricing.json');

// ─────────────────────────────────────────────────────────────────────
// Slab tables — single source of truth, encoded here, NOT in the prompt.
// ─────────────────────────────────────────────────────────────────────
const END_CONSUMER_SLABS = [
  { min: 1,    max: 19,       discount: 0      },
  { min: 20,   max: 99,       discount: 0.025  }, // 2.5% midpoint of 0-5%
  { min: 100,  max: 499,      discount: 0.125  }, // 12.5% midpoint of 10-15%
  { min: 500,  max: 2000,     discount: 0.325  }, // 32.5% midpoint of 30-35%
  { min: 2001, max: Infinity, discount: 0.40   }
];

const RESELLER_SLABS = [
  { min: 1,  max: 9,        discount: 0    },
  { min: 10, max: 29,       discount: 0.10 },
  { min: 30, max: 49,       discount: 0.30 },
  { min: 50, max: Infinity, discount: 0.40 }
];

// ─────────────────────────────────────────────────────────────────────
// GST rates — 18% for diary/pen/glass-bottle, 5% for everything else cork.
// ─────────────────────────────────────────────────────────────────────
const HIGH_GST_PATTERNS = [
  /\bdiary\b/i, /\bdiaries\b/i,
  /\bpen\b/i,
  /\bglass bottle\b/i,
  /\borganizer cum diary\b/i  // diaries-class
];
function getGstRate(productName) {
  return HIGH_GST_PATTERNS.some(re => re.test(productName)) ? 0.18 : 0.05;
}

// ─────────────────────────────────────────────────────────────────────
// Branding rules (single source of truth — matches what's in the prompt).
// ─────────────────────────────────────────────────────────────────────
const BRANDING_OPTIONS = {
  'single-color':   { rate: 2,  setup: 300, label: 'single-color screen printing' },
  'pad-printing':   { rate: 2,  setup: 300, label: 'pad printing' },
  'multi-color':    { rate: 10, setup: 300, label: 'multi-color UV/DTF printing' },
  'laser':          { rate: 8,  setup: 0,   label: 'laser engraving' }
};

// Pen-specific restriction: only laser allowed
const PEN_PATTERNS = [/\bpen\b/i];
function isProductPen(productName) {
  return PEN_PATTERNS.some(re => re.test(productName));
}
function isBrandingAllowedForProduct(brandingKey, productName) {
  if (isProductPen(productName)) {
    return brandingKey === 'laser';
  }
  return brandingKey in BRANDING_OPTIONS;
}

// ─────────────────────────────────────────────────────────────────────
// Catalog loading & lookup
// ─────────────────────────────────────────────────────────────────────
let _catalogCache = null;
let _catalogLoadedAt = 0;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function loadCatalog() {
  if (_catalogCache && Date.now() - _catalogLoadedAt < CATALOG_TTL_MS) {
    return _catalogCache;
  }
  if (!fs.existsSync(PRICING_FILE)) {
    throw new Error(`Catalog not found at ${PRICING_FILE}`);
  }
  _catalogCache = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf-8'));
  _catalogLoadedAt = Date.now();
  return _catalogCache;
}

function invalidateCatalogCache() {
  _catalogCache = null;
  _catalogLoadedAt = 0;
}

// Stop-words filtered out of queries so phrases like "caddy no 17" → "caddy 17"
const STOP_WORDS = new Set([
  'no', 'the', 'a', 'an', 'of', 'for', 'with', 'and', 'or', 'in', 'on',
  'pcs', 'piece', 'pieces', 'nos', 'qty', 'quantity', 'each',
  'cork'  // 'cork' alone is too broad — most products contain it
]);

// Simple English stemmer for plural/singular matching: "diaries" ↔ "diary",
// "coasters" ↔ "coaster", "boxes" ↔ "box". So a customer asking for "diaries"
// matches a catalog "ECODESK DIARY A5" without needing exact case/number.
function stem(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

// Score a product's name match against the query. Returns 0 (no match) → 100 (perfect).
// Strict rule: ALL non-stopword tokens in the query (length ≥ 2), after stemming,
// MUST appear (stemmed) in the product name. Eliminates false positives like
// "cork pen" matching "CORK BELLY COASTER", but handles plural/singular gracefully.
function scoreMatch(productName, query) {
  const pname = productName.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (pname === q) return 100;

  const pTokens = new Set(
    pname.split(/[\s/&\-,.]+/)
      .filter(t => t.length >= 2)
      .map(stem)
  );
  const qTokens = q.split(/[\s/&\-,.]+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
    .map(stem);

  if (qTokens.length === 0) return 0;
  if (!qTokens.every(t => pTokens.has(t))) return 0;

  const ratio = qTokens.length / Math.max(pTokens.size, 1);
  return Math.floor(50 + ratio * 50);
}

// Find products matching the query, sorted by score desc.
function findProducts(query) {
  const data = loadCatalog();
  const candidates = [];

  for (const p of (data.horeca || [])) {
    if (!p.name || !p.mrpPrice) continue;
    const score = scoreMatch(p.name, query);
    if (score > 0) candidates.push({ source: 'horeca', name: p.name, mrp: p.mrpPrice, productId: p.productId, score });
  }
  for (const p of (data.catalogue || [])) {
    if (!p.name || !p.price) continue;
    const score = scoreMatch(p.name, query);
    if (score > 0) candidates.push({ source: 'catalogue', name: p.name, mrp: p.price, score });
  }
  for (const p of (data.trophies || [])) {
    if (!p.name || !p.price) continue;
    const score = scoreMatch(p.name, query);
    if (score > 0) candidates.push({ source: 'trophies', name: p.name, mrp: p.price, productCode: p.productCode, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────
// Discount slab lookup
// ─────────────────────────────────────────────────────────────────────
function getSlabDiscount(quantity, customerType) {
  const slabs = customerType === 'reseller' ? RESELLER_SLABS : END_CONSUMER_SLABS;
  const slab = slabs.find(s => quantity >= s.min && quantity <= s.max);
  return slab ? slab.discount : 0;
}

// ─────────────────────────────────────────────────────────────────────
// Main quote computation
// ─────────────────────────────────────────────────────────────────────
function computeQuote({ productQuery, quantity, customerType, branding }) {
  // Validate inputs
  if (!productQuery || typeof productQuery !== 'string') {
    return { found: false, error: 'missing_product' };
  }
  if (!quantity || !Number.isFinite(quantity) || quantity < 1) {
    return { found: false, error: 'missing_quantity' };
  }
  if (!customerType || (customerType !== 'end_consumer' && customerType !== 'reseller')) {
    return { found: false, error: 'missing_customer_type' };
  }

  // Find matching products
  const matches = findProducts(productQuery);
  if (matches.length === 0) {
    return { found: false, error: 'product_not_found', productQuery };
  }

  // If top match is much better than #2, use it; otherwise treat as ambiguous
  const top = matches[0];
  const second = matches[1];
  if (matches.length > 1 && second && (top.score - second.score) < 20 && top.score < 100) {
    return {
      found: false,
      error: 'multiple_matches',
      matches: matches.slice(0, 8).map(m => ({ name: m.name, mrp: m.mrp, sku: m.productId || m.productCode || null }))
    };
  }

  // Compute per-piece price (rounded to whole rupee for customer-facing)
  const discount = getSlabDiscount(quantity, customerType);
  const perPieceExact = top.mrp * (1 - discount);
  const perPiece = Math.round(perPieceExact);
  const productSubtotalEx = perPiece * quantity;
  const productGst = Math.round(productSubtotalEx * getGstRate(top.name));

  // Optional branding
  let brandingDetail = null;
  let brandingSubtotalEx = 0;
  let brandingGst = 0;
  if (branding) {
    if (!isBrandingAllowedForProduct(branding, top.name)) {
      return {
        found: false,
        error: 'branding_not_allowed_for_product',
        product: top.name,
        requestedBranding: branding,
        allowedBranding: isProductPen(top.name) ? ['laser'] : Object.keys(BRANDING_OPTIONS)
      };
    }
    const opt = BRANDING_OPTIONS[branding];
    brandingSubtotalEx = quantity > 100 ? opt.rate * quantity : opt.setup;
    brandingGst = Math.round(brandingSubtotalEx * 0.18);
    brandingDetail = {
      key: branding,
      label: opt.label,
      ratePerPc: opt.rate,
      setupFee: opt.setup,
      quantityRule: quantity > 100 ? 'per_piece' : 'setup',
      subtotalEx: brandingSubtotalEx
    };
  }

  const subtotalEx = productSubtotalEx + brandingSubtotalEx;
  const totalGst = productGst + brandingGst;
  const grandTotal = subtotalEx + totalGst;

  return {
    found: true,
    product: {
      name: top.name,
      sku: top.productId || top.productCode || null,
      catalogMrp: top.mrp,
      source: top.source
    },
    customerType,
    quantity,
    perPiece,
    productSubtotalEx,
    productGstRate: getGstRate(top.name),
    productGst,
    branding: brandingDetail,
    brandingGst,
    subtotalEx,
    totalGst,
    grandTotal
  };
}

// ─────────────────────────────────────────────────────────────────────
// Format a quote as a clean customer-facing message
// ─────────────────────────────────────────────────────────────────────
function formatQuoteForCustomer(quote) {
  if (!quote || !quote.found) return null;
  const lines = [];
  const productLabel = quote.product.name.replace(/\bA5\b/g, 'A5'); // keep SKU specifics
  lines.push(`For ${quote.quantity} ${productLabel}${quote.branding ? ' with ' + quote.branding.label : ''}: ₹${quote.perPiece.toLocaleString('en-IN')} per piece.`);
  if (quote.branding) {
    if (quote.branding.quantityRule === 'per_piece') {
      lines.push(`Branding: ₹${quote.branding.ratePerPc} per piece.`);
    } else {
      lines.push(`Branding setup: ₹${quote.branding.setupFee} flat.`);
    }
  }
  lines.push(`Total ₹${quote.grandTotal.toLocaleString('en-IN')} incl. GST.`);
  lines.push(`Would you like to proceed?`);
  return lines.join(' ');
}

module.exports = {
  computeQuote,
  formatQuoteForCustomer,
  findProducts,
  loadCatalog,
  invalidateCatalogCache,
  // exports for testing
  getSlabDiscount,
  getGstRate,
  isBrandingAllowedForProduct,
  END_CONSUMER_SLABS,
  RESELLER_SLABS,
  BRANDING_OPTIONS
};
