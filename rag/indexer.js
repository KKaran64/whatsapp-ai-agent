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
  // If the bot mentions a diary AND quotes a per-piece price suspiciously close to
  // a known bulkPrice (which means it discounted off the floor instead of MRP),
  // flag as bot_error. End consumer quotes should land in the MRP-derived range.
  //
  // For the A5 diary specifically: MRP ₹225 → end-consumer quotes should be ~₹191-202.
  // A quote of ~₹118 means the bot used ₹135 (bulkPrice) as the base — exactly the
  // bug we keep accidentally retraining. Catalog A5: mrp=225, bulk=135.
  if (/dia(r|ies)/i.test(bot)) {
    // Look for "per [diary|piece|each]" prices in the response
    const perPieceMatches = [...bot.matchAll(/₹\s*(\d+(?:\.\d+)?)(?:\s*\/|\s+per\s+(?:diary|piece|pc))/gi)];
    for (const m of perPieceMatches) {
      const price = parseFloat(m[1]);
      // A5 diary bulkPrice is ₹135. Quotes between ₹110-₹140 for a diary
      // strongly imply the bot discounted off bulk instead of MRP.
      if (price >= 110 && price <= 140) {
        reasons.push('diary_priced_off_bulk_not_mrp');
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
