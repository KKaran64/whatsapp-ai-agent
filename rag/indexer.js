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

async function indexQAPair(pair) {
  if (!isConfigured()) {
    return { success: false, skipped: true, reason: 'Pinecone not configured' };
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
    outcome: pair.outcome || 'in_progress',
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

module.exports = { indexQAPair, indexConversation, makeVectorId };
