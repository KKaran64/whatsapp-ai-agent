// Writes embedded Q&A pairs to Pinecone with rich metadata.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getIndex, isConfigured } = require('./pinecone-client');
const { embedText } = require('./embed');

const STALE_PRICING_DAYS = 90;

// Catalog index by product-noun for the wrong-base-price detector.
// Built lazily from data/pricing.json on first validator call, then cached.
//
// Structure: { diary: [{mrp, bulk, name}, ...], coaster: [...], ... }
// Covers ALL 413 SKUs across HORECA + catalogue + trophies.
const PRODUCT_NOUN_GROUPS = {
  diary: ['diary', 'diaries'],
  coaster: ['coaster', 'coasters'],
  planter: ['planter', 'planters'],
  bag: ['bag', 'bags'],
  sleeve: ['sleeve', 'sleeves'],
  organizer: ['organizer', 'organizers'],
  frame: ['frame', 'frames'],
  tray: ['tray', 'trays'],
  holder: ['holder', 'holders'],
  bottle: ['bottle', 'bottles'],
  trivet: ['trivet', 'trivets'],
  tablemat: ['tablemat', 'tablemats'],
  clock: ['clock', 'clocks'],
  trophy: ['trophy', 'trophies'],
  pouch: ['pouch', 'pouches'],
  wallet: ['wallet', 'wallets'],
  box: ['box', 'boxes'],
  brick: ['brick', 'bricks'],
  ball: ['ball', 'balls'],
  roller: ['roller', 'rollers']
};

let _catalogByNoun = null;
function getCatalogByNoun() {
  if (_catalogByNoun) return _catalogByNoun;
  try {
    const file = path.join(__dirname, '..', 'data', 'pricing.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));

    // Flatten all products with their MRP and bulkPrice (when available)
    const all = [];
    for (const p of (data.horeca || [])) {
      if (p.name && p.mrpPrice) all.push({ name: p.name.toLowerCase(), mrp: p.mrpPrice, bulk: p.bulkPrice || null });
    }
    for (const p of (data.catalogue || [])) {
      if (p.name && p.price) all.push({ name: p.name.toLowerCase(), mrp: p.price, bulk: null });
    }
    for (const p of (data.trophies || [])) {
      if (p.name && p.price) all.push({ name: p.name.toLowerCase(), mrp: p.price, bulk: null });
    }

    // Bucket products under each canonical noun
    const map = {};
    for (const [canonical, variants] of Object.entries(PRODUCT_NOUN_GROUPS)) {
      const matches = all.filter(p => variants.some(v => p.name.includes(v)));
      if (matches.length > 0) map[canonical] = matches;
    }
    _catalogByNoun = map;
    return _catalogByNoun;
  } catch (e) {
    console.warn('⚠️ Validator catalog load failed:', e.message);
    return null;
  }
}

// Detect which product nouns are mentioned in the bot's response
function detectMentionedNouns(text) {
  const lower = text.toLowerCase();
  const mentioned = [];
  for (const [canonical, variants] of Object.entries(PRODUCT_NOUN_GROUPS)) {
    if (variants.some(v => new RegExp('\\b' + v + '\\b').test(lower))) {
      mentioned.push(canonical);
    }
  }
  return mentioned;
}

function makeVectorId(customerPhone, timestamp, suffix = '') {
  const hash = crypto.createHash('md5').update(`${customerPhone}_${timestamp}_${suffix}`).digest('hex');
  return `vec_${hash.substring(0, 16)}`;
}

function isStaleForPricing(timestamp) {
  const ageMs = Date.now() - timestamp;
  return ageMs > STALE_PRICING_DAYS * 24 * 60 * 60 * 1000;
}

// v59 quality gate: detect bot errors before they enter the retrieval pool.
// Even though the retriever already filters for outcome='sale', a sale that
// happened DESPITE a bad bot response would still pollute future answers.
// Tagging with outcome='bot_error' makes the vector permanently un-retrievable
// regardless of what outcome the conversation eventually gets.
function validateConversationQuality(pair) {
  const reasons = [];
  const customer = String(pair.customerMessage || '');
  const bot = String(pair.botResponse || '');

  // Bot quoted a price range like "₹114.75-₹121.50" — RULE A violation
  if (/₹\s*[\d,]+(?:\.\d+)?\s*[-–]\s*[\d,]+(?:\.\d+)?/.test(bot)) {
    reasons.push('bot_quoted_price_range');
  }

  // Bot used cave-on-discount language — discount slab violation
  if (/let'?s use \d+%|one[\s-]time exception|loyalty bonus|as a request|as a final offer/i.test(bot)) {
    reasons.push('bot_caved_on_discount');
  }

  // GST double-counting heuristic: bot baked GST into a SUB-ITEM
  // (e.g. "₹200 plus 18% GST, which is ₹36") AND ALSO listed "GST on [item]"
  // as a separate aggregated line in the same response. The combo is the
  // RULE B anti-pattern from tonight's bug. Allows the legit case where bot
  // only adds "+ 18% GST" once at the bottom as a single tally.
  const hasInlineGstBaked = /(?:\+|plus)\s*\d+\s*%?\s*gst[\s\S]{0,40}₹[\d,]+/i.test(bot);
  const hasSeparateGst = /gst on \w+/i.test(bot);
  if (hasInlineGstBaked && hasSeparateGst) {
    reasons.push('gst_double_count');
  }

  // Customer expressed distrust or flagged inconsistency in this turn
  if (/don'?t (want|trust)|cant go back|i don'?t believe you|gave vague|miscommunication/i.test(customer)) {
    reasons.push('customer_distrust');
  }
  if (/(your )?pricing says|earlier you said|first you said|that'?s different|wasn'?t the price/i.test(customer)) {
    reasons.push('customer_flagged_inconsistency');
  }

  // Wrong-base-price detector (v59 Scenario B enforcement, UNIVERSAL):
  // Reverse-engineer the implied discount BASE from any per-piece quote with a
  // nearby discount %, then check if that base matches a bulkPrice for any product
  // noun mentioned in the response — AND is NOT also a valid MRP for that noun.
  //
  // Example: bot says "₹118.13 per piece (12.5% discount)" → implied base 135.
  // ₹135 is A5 diary's bulkPrice, AND ₹135 is not anyone's diary MRP → flag.
  //
  // Disambiguation: if bot says "₹135 per pouch" (12.5% off), implied base = 154.29
  // which is NOT a known price — so no flag. But "₹135 per pouch" (no discount)
  // is just ₹135 = Cork & Canvas Pouch MRP → also no flag.
  //
  // Covers ALL 413 catalog SKUs without false positives across categories.
  const catalog = getCatalogByNoun();
  const mentionedNouns = detectMentionedNouns(bot);
  if (catalog && mentionedNouns.length > 0) {
    // Find per-piece price quotes with their text position
    const pricePattern = /₹\s*(\d+(?:\.\d+)?)\s*(?:per|\/|each|a)\s+(piece|pc|diary|diaries|coaster|coasters|planter|planters|bag|bags|sleeve|sleeves|organizer|organizers|frame|frames|tray|trays|holder|holders|bottle|bottles|trivet|trivets|tablemat|tablemats|clock|clocks|trophy|trophies|pouch|pouches|wallet|wallets|box|boxes|brick|bricks|ball|balls|roller|rollers)\b/gi;
    const discountPattern = /(\d+(?:\.\d+)?)\s*%\s*(?:off|discount)/gi;
    const discountHits = [...bot.matchAll(discountPattern)].map(m => ({ index: m.index, value: parseFloat(m[1]) }));

    for (const pm of [...bot.matchAll(pricePattern)]) {
      const price = parseFloat(pm[1]);
      const pos = pm.index;
      // Find nearest discount % within ±250 chars (typical bot quote span)
      const nearby = discountHits.find(d => Math.abs(d.index - pos) <= 250);
      if (!nearby || nearby.value >= 100) continue;

      // Reverse-engineer the discount base the bot used
      const impliedBase = price / (1 - nearby.value / 100);

      // Tolerance: ±2% of the implied base, since bot rounds final per-piece prices
      const tol = Math.max(2, impliedBase * 0.02);

      // For each mentioned product noun, check the catalog:
      //   matches mrp? → bot used MRP correctly (don't flag)
      //   matches bulk only? → bot used bulkPrice as base (FLAG)
      let baseIsValidMrp = false;
      let baseIsBulkOnly = false;
      for (const noun of mentionedNouns) {
        const products = catalog[noun] || [];
        for (const p of products) {
          if (Math.abs(p.mrp - impliedBase) < tol) baseIsValidMrp = true;
          if (p.bulk != null && Math.abs(p.bulk - impliedBase) < tol) baseIsBulkOnly = true;
        }
      }
      if (baseIsValidMrp) continue; // valid MRP-derived quote, even if also matches a bulk
      if (baseIsBulkOnly) {
        reasons.push(`discount_applied_to_bulkprice_not_mrp`);
        break;
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

async function indexQAPair(pair) {
  if (!isConfigured()) {
    return { success: false, skipped: true, reason: 'Pinecone not configured' };
  }

  // v59 quality gate: if this turn shows bot-error signals, override outcome
  // to 'bot_error' so it can never be retrieved (retriever filters outcome='sale').
  // We still INDEX the vector for later analysis / prompt-improvement reports.
  const quality = validateConversationQuality(pair);
  const effectiveOutcome = quality.valid
    ? (pair.outcome || 'in_progress')
    : 'bot_error';
  if (!quality.valid) {
    console.warn(`⚠️ RAG quality gate: tagging vector outcome=bot_error (${quality.reasons.join(', ')})`);
  }

  const embedInput = `Customer: ${pair.customerMessage}\nBot: ${pair.botResponse || ''}`;
  const vector = await embedText(embedInput);

  if (!vector) {
    return { success: false, reason: 'Embedding failed' };
  }

  const id = makeVectorId(pair.customerPhone || 'unknown', pair.timestamp || Date.now());
  const metadata = {
    customerPhone: pair.customerPhone || 'unknown',
    customerMessage: (pair.customerMessage || '').substring(0, 1000),
    botResponse: (pair.botResponse || '').substring(0, 1000),
    products: pair.products || [],
    quantity: Number(pair.quantity) || 0,
    budget: Number(pair.budget) || 0,
    outcome: effectiveOutcome,
    qualityReasons: quality.reasons, // empty array on clean conversations
    saleAmount: Number(pair.saleAmount) || 0,
    timestamp: pair.timestamp || Date.now(),
    isStaleForPricing: isStaleForPricing(pair.timestamp || Date.now()),
    productStillAvailable: pair.productStillAvailable !== false,
    conversationStage: pair.conversationStage || 'unknown'
  };

  try {
    const index = getIndex();
    await index.upsert([{ id, values: vector, metadata }]);
    return { success: true, id };
  } catch (err) {
    console.error('❌ Pinecone upsert failed:', err.message);
    return { success: false, reason: err.message };
  }
}

async function indexConversation({ customerPhone, qaPairs, outcome, saleAmount, products, customerType, budget }) {
  let indexed = 0;
  const ids = [];

  for (const pair of qaPairs) {
    const result = await indexQAPair({
      ...pair,
      customerPhone,
      outcome,
      saleAmount,
      products,
      customerType,
      budget
    });
    if (result.success) {
      indexed++;
      ids.push(result.id);
    }
    await new Promise(r => setTimeout(r, 50));
  }

  return { indexed, total: qaPairs.length, ids };
}

module.exports = { indexQAPair, indexConversation, makeVectorId, validateConversationQuality };
