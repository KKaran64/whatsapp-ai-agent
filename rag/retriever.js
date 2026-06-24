// Retrieves relevant context for a customer message:
//  1. Customer's own past conversations (personalization)
//  2. Top-K similar successful conversations (learning)
//  3. Product-specific reference data
// Runs queries in parallel. Falls back gracefully on any failure.

const { getIndex, isConfigured } = require('./pinecone-client');
const { embedText } = require('./embed');

const PRICING_KEYWORDS = /\b(price|cost|how much|rate|₹|rs\.?|inr|budget|expensive|cheap)\b/i;

function isPricingQuery(message) {
  return PRICING_KEYWORDS.test(message);
}

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ matches: [], timedOut: true }), ms))
  ]);
}

async function retrieveContext({ message, customerPhone, timeoutMs = 2000 }) {
  if (!isConfigured()) {
    return { customerHistory: [], similarConversations: [], productContext: [], usedRAG: false };
  }

  const vector = await embedText(message);
  if (!vector) {
    return { customerHistory: [], similarConversations: [], productContext: [], usedRAG: false };
  }

  const index = getIndex();
  const pricing = isPricingQuery(message);

  const customerHistoryPromise = withTimeout(
    index.query({
      vector, topK: 3, includeMetadata: true,
      filter: { customerPhone: { $eq: customerPhone } }
    }).catch(() => ({ matches: [] })),
    timeoutMs
  );

  // v58: ONLY retrieve confirmed-sale examples. 'in_progress' is excluded — they're
  // unvalidated, and the bot's own buggy responses get indexed as in_progress and
  // would otherwise loop back as "successful examples" within minutes.
  const similarFilter = { outcome: { $eq: 'sale' } };
  if (pricing) {
    similarFilter.isStaleForPricing = { $eq: false };
    similarFilter.productStillAvailable = { $eq: true };
  }

  const similarPromise = withTimeout(
    index.query({
      vector, topK: 5, includeMetadata: true, filter: similarFilter
    }).catch(() => ({ matches: [] })),
    timeoutMs
  );

  const productPromise = withTimeout(
    index.query({
      vector, topK: 3, includeMetadata: true,
      filter: { outcome: { $eq: 'sale' } }
    }).catch(() => ({ matches: [] })),
    timeoutMs
  );

  const [history, similar, product] = await Promise.all([customerHistoryPromise, similarPromise, productPromise]);

  return {
    customerHistory: (history.matches || []).map(m => m.metadata),
    similarConversations: (similar.matches || []).map(m => m.metadata),
    productContext: (product.matches || []).map(m => m.metadata),
    usedRAG: true,
    timedOut: history.timedOut || similar.timedOut || product.timedOut
  };
}

module.exports = { retrieveContext, isPricingQuery };
