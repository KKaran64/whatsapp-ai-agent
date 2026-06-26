// Writes embedded Q&A pairs to Pinecone with rich metadata.

const crypto = require('crypto');
const { getIndex, isConfigured } = require('./pinecone-client');
const { embedText } = require('./embed');

const STALE_PRICING_DAYS = 90;

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

  // Wrong-base-price detector (v59 Scenario B enforcement):
  // Conservative hardcoded ranges of known "discount-off-bulkPrice" bugs per category.
  // Extending the catalog-aware approach proved too noisy — diaries with widely varying
  // MRPs (A6 ₹153 to Organizer Cum Diary ₹917) created overlapping suspicious ranges
  // that produced false positives on legitimate quotes. Hardcoded ranges trade
  // coverage for high precision: we only flag specifically observed bug patterns.
  // Extend this list as new bug patterns surface in production.
  const KNOWN_WRONG_PRICE_RANGES = [
    // A5 diary: bulkPrice ₹135 × discount [85-95%] = quotes ~115-130/diary
    { noun: 'diary', min: 110, max: 132, derivation: 'A5 bulk ₹135 × discount' },
    { noun: 'diaries', min: 110, max: 132, derivation: 'A5 bulk ₹135 × discount' },
    // 5mm coaster: bulkPrice ₹17 × discount [85-95%] = quotes ~14-16/coaster
    { noun: 'coaster', min: 13, max: 16, derivation: '5mm coaster bulk ₹17 × discount' },
    { noun: 'coasters', min: 13, max: 16, derivation: '5mm coaster bulk ₹17 × discount' }
  ];
  const perPiecePattern = /₹\s*(\d+(?:\.\d+)?)\s*(?:per|\/|a)\s+(diary|diaries|coaster|coasters)/gi;
  const matches = [...bot.matchAll(perPiecePattern)];
  for (const m of matches) {
    const price = parseFloat(m[1]);
    const noun = m[2].toLowerCase();
    const range = KNOWN_WRONG_PRICE_RANGES.find(r => r.noun === noun);
    if (range && price >= range.min && price <= range.max) {
      reasons.push(`priced_off_bulk_not_mrp_${noun}`);
      break;
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
