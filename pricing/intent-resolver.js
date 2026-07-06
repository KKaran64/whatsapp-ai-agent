// Intent Resolver — LLM-first extraction (replaces regex-primary extraction).
//
// One Groq call per inbound message reads the recent conversation and fills
// the intent form the quote engine needs. The LLM only UNDERSTANDS — it never
// sees the catalog, never names a SKU, never computes a price. Selection and
// pricing stay in the deterministic quote-engine.
//
// Fallback ladder:
//   INTENT_RESOLVER=regex env        → regex extractor (kill-switch)
//   groq-client returns null         → regex extractor, source:'regex_fallback'
//   LLM output field invalid         → that FIELD nulled, rest kept
//
// Regex fallback keeps confidence 1.0 so quoting continues through an LLM
// outage exactly as it does today (the confidence gate applies to llm source).

const { callGroqJson, DEFAULT_BUDGET_MS } = require('./groq-client');
const { extractIntent } = require('./intent-extractor');

const CUSTOMER_TYPES = new Set(['end_consumer', 'reseller']);
const BRANDING_KEYS = new Set(['single-color', 'pad-printing', 'multi-color', 'laser']);
const PACKAGING_KEYS = new Set(['individual_boxes']);

// Process-lifetime telemetry — exposed on /stats so degraded turns are visible.
const stats = { llm: 0, regexFallback: 0, noIntent: 0 };
function getResolverStats() {
  return { ...stats };
}

const SYSTEM_PROMPT = `You extract purchase intent from a WhatsApp sales conversation for a cork products business.

Read the conversation (most recent message last) and fill this JSON form. Output ONLY the JSON object, no prose:

{
  "productQuery": "<the product noun phrase the customer wants, e.g. 'mat', 'diary', 'bar caddy'; null if none>",
  "refinements": ["<narrowing terms the customer stated: variants, sizes, materials, use-case qualifiers like 'desktop', 'a5', 'round'; prefix '!' for explicit rejections like '!yoga'>"],
  "quantity": <integer number of pieces, or null>,
  "customerType": "end_consumer" | "reseller" | null,
  "branding": "single-color" | "pad-printing" | "multi-color" | "laser" | null,
  "packaging": "individual_boxes" | null,
  "confidence": <0.0-1.0 how sure you are about the OVERALL extraction>,
  "reasoning": "<one sentence>"
}

Rules:
- productQuery is the customer's own noun phrase, NEVER a catalog SKU name you invent.
- refinements accumulate across the WHOLE conversation. If the customer narrowed earlier ("for office work desktop mats are better") and later asks something else, KEEP the narrowing.
- customerType: buying for their own use/business (hotel, office, gifting their employees) = end_consumer; buying to resell/distribute = reseller. null if unstated.
- branding only if the customer asked for logo/printing/engraving. "with logo" = single-color.
- packaging: "individual_boxes" ONLY if the customer asks for items packed in individual/separate boxes (per-piece boxes, gift boxes each). A question about HOW goods are shipped/sent/packed in transit is NOT a boxes request → null.
- If the conversation has NO purchase/pricing intent at all (greeting, thanks, support question), return all business fields null with high confidence.
- Numbers written as words ("two hundred") → the integer (200).

Examples:

Conversation:
  customer: i need 200 mats for office, for my own use
  assistant: We have Coffee Mat, Desktop Mat, Yoga Mat — which one?
  customer: for office work desktop mats are better right
  customer: what are the other options?
→ {"productQuery": "mat", "refinements": ["desktop", "office"], "quantity": 200, "customerType": "end_consumer", "branding": null, "packaging": null, "confidence": 0.9, "reasoning": "wants desktop mats for own office use; refinement kept while exploring options"}

Conversation:
  customer: i need diaries for corporate gifting to my clients
  customer: A5 size, around 150 pcs with our logo
→ {"productQuery": "diary", "refinements": ["a5"], "quantity": 150, "customerType": "end_consumer", "branding": "single-color", "packaging": null, "confidence": 0.9, "reasoning": "corporate gifting for own clients, A5 diaries with logo"}

Conversation:
  customer: i need 400 magnetic planters for reselling
  customer: can you pack each one in its own box?
→ {"productQuery": "planter", "refinements": ["magnetic"], "quantity": 400, "customerType": "reseller", "branding": null, "packaging": "individual_boxes", "confidence": 0.9, "reasoning": "reseller wants each planter individually boxed"}

Conversation:
  customer: 400 magnetic planters. how do you send the goods?
→ {"productQuery": "planter", "refinements": ["magnetic"], "quantity": 400, "customerType": null, "branding": null, "packaging": null, "confidence": 0.85, "reasoning": "shipping-method question, not an individual-boxes request"}

Conversation:
  customer: hello, are you there?
→ {"productQuery": null, "refinements": [], "quantity": null, "customerType": null, "branding": null, "packaging": null, "confidence": 0.95, "reasoning": "greeting only, no purchase intent"}

Conversation:
  customer: show me mats but not yoga ones, i'm a distributor
→ {"productQuery": "mat", "refinements": ["!yoga"], "quantity": null, "customerType": "reseller", "branding": null, "packaging": null, "confidence": 0.85, "reasoning": "distributor wants non-yoga mats"}`;

// ── Field-level validation: a bad field is nulled, the rest survives. ──
function validateIntent(raw) {
  const out = {
    productQuery: null,
    refinements: [],
    quantity: null,
    customerType: null,
    branding: null,
    packaging: null,
    confidence: 0.5,
    reasoning: ''
  };
  if (!raw || typeof raw !== 'object') return out;

  if (typeof raw.productQuery === 'string' && raw.productQuery.trim()) {
    out.productQuery = raw.productQuery.trim();
  }
  if (Array.isArray(raw.refinements)) {
    out.refinements = raw.refinements
      .filter(r => typeof r === 'string' && r.trim())
      .map(r => r.trim().toLowerCase())
      .slice(0, 6);
  }
  const qty = Number(raw.quantity);
  if (Number.isFinite(qty) && Number.isInteger(qty) && qty >= 1 && qty <= 99999) {
    out.quantity = qty;
  }
  if (CUSTOMER_TYPES.has(raw.customerType)) out.customerType = raw.customerType;
  if (BRANDING_KEYS.has(raw.branding)) out.branding = raw.branding;
  if (PACKAGING_KEYS.has(raw.packaging)) out.packaging = raw.packaging;
  const conf = Number(raw.confidence);
  if (Number.isFinite(conf) && conf >= 0 && conf <= 1) out.confidence = conf;
  out.reasoning = String(raw.reasoning || '').substring(0, 200);
  return out;
}

function regexFallback(currentMessage, contextMessages, why) {
  const regexIntent = extractIntent(currentMessage, contextMessages);
  if (!regexIntent) {
    stats.noIntent++;
    return null;
  }
  stats.regexFallback++;
  console.warn(`⚠️ intent-resolver: regex_fallback — ${why}`);
  return {
    productQuery: regexIntent.productQuery || null,
    refinements: [],
    quantity: regexIntent.quantity || null,
    customerType: regexIntent.customerType || null,
    branding: regexIntent.branding || null,
    packaging: regexIntent.packaging || null,
    confidence: 1.0,
    source: 'regex_fallback',
    reasoning: `regex fallback (${why})`
  };
}

async function resolveIntent(currentMessage, contextMessages = [], options = {}) {
  if (!currentMessage || typeof currentMessage !== 'string') return null;

  if (process.env.INTENT_RESOLVER === 'regex') {
    return regexFallback(currentMessage, contextMessages, 'kill-switch INTENT_RESOLVER=regex');
  }

  // Same conversation window the regex extractor uses: last 10 messages.
  const windowLines = [
    ...contextMessages.slice(-10).map(m => {
      const who = (m.role === 'user' || m.role === 'customer') ? 'customer' : 'assistant';
      return `${who}: ${String(m.content || '').substring(0, 400)}`;
    }),
    `customer: ${currentMessage.substring(0, 800)}`
  ];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Conversation:\n${windowLines.join('\n')}\n\nFill the intent form. JSON only.` }
  ];

  const raw = await callGroqJson(messages, { budgetMs: options.budgetMs || DEFAULT_BUDGET_MS });
  if (raw === null) {
    return regexFallback(currentMessage, contextMessages, 'llm unavailable');
  }

  const intent = validateIntent(raw);

  // All business fields empty → this turn carries no pricing intent.
  if (!intent.productQuery && !intent.quantity && !intent.customerType && !intent.branding && !intent.packaging) {
    stats.noIntent++;
    return null;
  }

  stats.llm++;
  return { ...intent, source: 'llm' };
}

module.exports = {
  resolveIntent,
  getResolverStats,
  // exported for tests
  validateIntent
};
