// Conversation State Machine — v61 Phase B.1
//
// Derives the current conversation state from accumulated facts (product, qty,
// customer type, branding, invoice fields, etc.) and provides a guard layer
// that constrains what the bot is allowed to do in each state.
//
// PHILOSOPHY:
//   The LLM is great at language, terrible at process discipline. Encoding
//   the conversation flow as code (states + transitions) eliminates entire
//   categories of bugs:
//     - Bot can't quote a price before knowing customer type (RULE F enforced)
//     - Bot can't ask for company name before the customer agrees to a quote
//     - Bot can't loop forever asking the same disambiguation question
//     - Bot can't share payment details before all invoice fields are collected
//
// USAGE (Phase B.1 — read-only):
//   const state = deriveState(conversation, currentIntent);
//   if (state.code === 'AWAITING_CUSTOMER_TYPE') {
//     // Inject guard into LLM context: "you MUST ask customer type"
//   }
//
// PHASE B.2 will add: action-allowlist enforcement, transition validation.
// PHASE B.3 will add: telemetry + state-aware Bigin sync.

// ─────────────────────────────────────────────────────────────────────
// State definitions
// ─────────────────────────────────────────────────────────────────────
//
// Each state declares:
//   - code: machine-readable identifier
//   - description: human-readable explanation
//   - canBotQuote: whether engine-injected quotes are allowed in this state
//   - allowedActions: what the bot is allowed to do
//   - nextStates: which states this can transition to
//   - guard: what to tell the LLM (injected into [STATE GUARD] block)
//
// States are derived, NOT stored. The derivation is a pure function of the
// conversation's accumulated facts. This means we never have to worry about
// "stale" state — every message re-derives from scratch.

const STATES = {
  GREETING: {
    code: 'GREETING',
    description: 'Conversation just started, no product mentioned yet',
    canBotQuote: false,
    allowedActions: ['greet', 'ask_what_brings_them', 'send_catalog_pdf'],
    guard: 'Customer just arrived. Greet warmly and ask what brings them — corporate gifting, business use, or personal? Do not list products or prices.'
  },

  QUALIFYING_PRODUCT: {
    code: 'QUALIFYING_PRODUCT',
    description: 'Customer is interested in something but hasn\'t specified a product',
    canBotQuote: false,
    allowedActions: ['ask_product_category', 'send_catalog_pdf', 'list_categories'],
    guard: 'Customer is browsing. Help them narrow down — ask what category they\'re interested in. Do NOT quote prices. Do NOT list MRPs.'
  },

  AWAITING_CUSTOMER_TYPE: {
    code: 'AWAITING_CUSTOMER_TYPE',
    description: 'Customer named a product but customer-type (end consumer vs reseller) is unknown',
    canBotQuote: false,
    allowedActions: ['ask_customer_type'],
    guard: 'RULE F: customer named a product but type is unknown. Your ONLY reply: "Sure, happy to help! Could you let me know if these are for your own use (corporate gifting, hotel, office, personal) or for resale?" — exact wording. Do NOT quote, do NOT ask other questions.'
  },

  AWAITING_QUANTITY: {
    code: 'AWAITING_QUANTITY',
    description: 'Product + customer type known, but quantity is missing',
    canBotQuote: false,
    allowedActions: ['ask_quantity'],
    guard: 'You know the product and customer type. Ask only: "How many pieces are you looking at?" Do NOT quote yet.'
  },

  AWAITING_PRODUCT_DISAMBIGUATION: {
    code: 'AWAITING_PRODUCT_DISAMBIGUATION',
    description: 'Customer mentioned a category but multiple SKUs match — need them to pick one',
    canBotQuote: false,
    allowedActions: ['ask_which_sku'],
    guard: 'The engine returned multiple matching SKUs. List the options BY NAME ONLY (no prices). Ask which one. Do NOT quote yet.'
  },

  AWAITING_BRANDING: {
    code: 'AWAITING_BRANDING',
    description: 'Product + qty + customer type known, but branding choice unclear',
    canBotQuote: false,
    allowedActions: ['ask_branding'],
    guard: 'Ask if they want branding: single-color, multi-color UV/DTF, laser engraving, or no branding. Pens only allow laser. Do NOT quote yet.'
  },

  READY_TO_QUOTE: {
    code: 'READY_TO_QUOTE',
    description: 'All info collected — engine will produce a VERIFIED QUOTE',
    canBotQuote: true,
    allowedActions: ['present_verified_quote'],
    guard: 'A [VERIFIED QUOTE] block is being injected. Present those EXACT numbers conversationally. Do NOT recalculate. End with "Would you like to proceed?"'
  },

  QUOTE_PRESENTED: {
    code: 'QUOTE_PRESENTED',
    description: 'Bot has shared a quote, awaiting customer decision',
    canBotQuote: true, // can re-quote the same SKU if customer asks again
    allowedActions: ['await_decision', 'answer_followup_question', 'handle_negotiation', 'modify_quote'],
    guard: 'You\'ve shared a quote. Wait for customer response. If they agree → move to invoice collection. If they negotiate → use SSN/DPS but never below slab cap. If they ask follow-up questions, answer briefly. Do NOT proactively re-quote.'
  },

  COLLECTING_INVOICE_INFO: {
    code: 'COLLECTING_INVOICE_INFO',
    description: 'Customer agreed to proceed, gathering company/GSTIN/address',
    canBotQuote: false, // already quoted; no new quotes here
    allowedActions: ['ask_next_invoice_field'],
    guard: 'Collecting invoice info. Ask for the NEXT missing field only: 1) company name, 2) GSTIN (or no-GST), 3) billing address with pin, 4) contact person name+phone, 5) shipping address. Never re-ask provided fields. Accept any input and move on.'
  },

  AWAITING_PAYMENT: {
    code: 'AWAITING_PAYMENT',
    description: 'All invoice info collected, payment details shared, awaiting screenshot',
    canBotQuote: false,
    allowedActions: ['confirm_payment_received', 'remind_payment_details'],
    guard: 'All invoice info collected. Share payment block (bank details), ask for payment screenshot. Wait for confirmation.'
  },

  ESCALATED: {
    code: 'ESCALATED',
    description: 'Customer asked something out of scope (foil, international shipping, etc.) — team follow-up required',
    canBotQuote: false,
    allowedActions: ['acknowledge_holding', 'continue_normal_conversation'],
    guard: 'RULE G escalation active. Bot used "let me check with our team" — the team will follow up. You may continue normal conversation if customer brings other topics up, but the escalation stays open.'
  },

  POST_SALE: {
    code: 'POST_SALE',
    description: 'Customer paid, order is being processed',
    canBotQuote: false,
    allowedActions: ['confirm_order', 'request_review', 'answer_delivery_questions'],
    guard: 'Payment confirmed. Acknowledge order, optionally request Google review (only at the 3 designated moments). For delivery questions, defer to team — never commit dates.'
  }
};

// ─────────────────────────────────────────────────────────────────────
// Fact extraction helpers
// ─────────────────────────────────────────────────────────────────────
// We re-derive facts from conversation history each time. No mutable state
// to fall out of sync.

function joinRecentMessages(conversation, lookbackTurns = 30) {
  // conversation: array of {role, content} OR Mongoose doc with .messages
  const msgs = Array.isArray(conversation)
    ? conversation
    : (conversation?.messages || []);
  const recent = msgs.slice(-lookbackTurns);
  const customerText = recent
    .filter(m => m.role === 'customer' || m.role === 'user')
    .map(m => m.content || '')
    .join(' \n ');
  const botText = recent
    .filter(m => m.role === 'agent' || m.role === 'assistant')
    .map(m => m.content || '')
    .join(' \n ');
  return { customerText, botText, combined: `${customerText}\n${botText}` };
}

// v61.1 — Hybrid customer-type detection: fast regex first (handles 80% of
// clear cases instantly), LLM classifier fallback for ambiguous/typo cases.
// The LLM call is async — sync callers get the regex result; async callers
// (state derivation) get the LLM verdict if regex returned null.
function hasCustomerType(customerText) {
  const reseller = /\b(reseller|i sell|for re-?sale|for re-?sell|wholesale|gifting business|i'?m a distributor|b2b distribution|i supply to corporates|i run a gifting|to resell)\b/i;
  const endConsumer = /\bfor (my|our) (hotel|restaurant|cafe|office|company|studio|shop|business)|personal use|for myself|corporate gift(ing)?|for (our|my) (employees|company event|team|store opening|launch)|opening (a|an|my|our) (yoga )?(studio|restaurant|hotel|cafe|shop|store)\b/i;
  if (reseller.test(customerText)) return 'reseller';
  if (endConsumer.test(customerText)) return 'end_consumer';
  return null;
}

function hasQuantity(customerText) {
  return /\b\d{1,5}\s*(pcs|pieces|nos|qty|quantity|mats|diaries|coasters|pens|bags|frames|trays|holders|planters|trophies|caddy|caddies|pouches|wallets|tablemats|trivets|bottles|clocks|sleeves|organizers|boxes|bricks|balls|rollers)\b|\b(?:i\s+)?(?:need|want|require)\s+\d+/i.test(customerText);
}

function hasInvoiceField(customerText, field) {
  switch (field) {
    case 'company':
      return /\b(pvt|private|llp|ltd|limited|company|enterprises|industries|sustainable|products|inc|gmbh)\b/i.test(customerText)
        || /\b[A-Z][A-Za-z]+\s+[A-Z][A-Za-z]+\b/.test(customerText); // crude two-cap-words
    case 'gstin':
      return /\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}\d{1}[Z]{1}[A-Z\d]{1}\b/i.test(customerText);
    case 'address':
      return /\b\d{6}\b/.test(customerText) // pin code is a strong signal
        || /\bsector\s+\d+|noida|delhi|mumbai|bangalore|chennai|kolkata|pune\b/i.test(customerText);
    default:
      return false;
  }
}

function botHasSharedQuote(botText) {
  // Bot's quotes from the engine always contain "₹ ... per piece" + "Total ₹"
  return /₹\s*[\d,]+/.test(botText) && /\bper (piece|diary|coaster|planter|caddy|trophy)\b|\btotal\s*₹/i.test(botText);
}

function botSharedPaymentBlock(botText) {
  return /(canara bank|cnrb0007617|120032289098|payment screenshot)/i.test(botText);
}

function customerAgreedToProceed(customerText) {
  return /\b(yes|ok|okay|sure|proceed|go ahead|haan|let'?s do it|done|confirm|alright|send invoice|share invoice|generate invoice)\b/i.test(customerText.slice(-200));
}

function escalationActive(botText) {
  return /\blet me check with (?:our|the) team\b|\bcome back to you within a few hours\b/i.test(botText);
}

function customerPaymentConfirmed(customerText) {
  return /\b(paid|transferred|payment done|payment sent|transaction successful|sent the payment|completed payment|done payment)\b/i.test(customerText)
    || /screenshot|receipt/i.test(customerText);
}

// ─────────────────────────────────────────────────────────────────────
// State derivation — the core public API
// ─────────────────────────────────────────────────────────────────────
//
// Two variants:
//   - deriveState()        — synchronous (uses regex only; null on miss)
//   - deriveStateAsync()   — async (falls back to LLM classifier on regex miss,
//                                   resilient to typos and paraphrasing)
//
// Callers in server.js use the async variant. Tests / internal helpers
// can use the sync variant when an LLM call is too expensive to await.

function deriveState(conversation, currentIntent = null) {
  const { customerText, botText } = joinRecentMessages(conversation);

  // ── Order matters: check terminal states first, then progress states ──

  // Has customer confirmed payment? → POST_SALE
  if (botSharedPaymentBlock(botText) && customerPaymentConfirmed(customerText)) {
    return _stateOf('POST_SALE', { reason: 'Payment confirmed by customer' });
  }

  // Bot shared payment details, waiting for proof → AWAITING_PAYMENT
  if (botSharedPaymentBlock(botText)) {
    return _stateOf('AWAITING_PAYMENT', { reason: 'Payment block sent, awaiting screenshot' });
  }

  // Has bot quoted AND customer agreed AND we have at least one invoice field?
  // → COLLECTING_INVOICE_INFO
  const hasCompany = hasInvoiceField(customerText, 'company');
  const hasGstin = hasInvoiceField(customerText, 'gstin');
  const hasAddress = hasInvoiceField(customerText, 'address');
  const hasAnyInvoiceField = hasCompany || hasGstin || hasAddress;
  const customerAgreed = customerAgreedToProceed(customerText);
  const quoteWasShared = botHasSharedQuote(botText);

  if (quoteWasShared && (customerAgreed || hasAnyInvoiceField)) {
    return _stateOf('COLLECTING_INVOICE_INFO', {
      reason: 'Quote accepted, gathering invoice fields',
      facts: { hasCompany, hasGstin, hasAddress }
    });
  }

  // Has bot already shared a quote? → QUOTE_PRESENTED (awaiting customer decision)
  if (quoteWasShared) {
    return _stateOf('QUOTE_PRESENTED', { reason: 'Bot shared quote, awaiting customer decision' });
  }

  // Is the engine ready to quote? (Phase B.2 will use this — for now we use
  // currentIntent if provided.)
  if (currentIntent && currentIntent.productQuery && currentIntent.quantity && currentIntent.customerType) {
    return _stateOf('READY_TO_QUOTE', {
      reason: 'All quote-required facts present',
      facts: currentIntent
    });
  }

  // Escalation explicitly active? → ESCALATED
  // (Note: we don't lock the conversation into this; the bot can continue
  // normal flow if customer brings up something else. This state just signals
  // "there's an open follow-up.")
  if (escalationActive(botText)) {
    // Use ESCALATED only if no other progress facts exist
    if (!currentIntent || (!currentIntent.productQuery && !currentIntent.quantity)) {
      return _stateOf('ESCALATED', { reason: 'RULE G escalation active' });
    }
  }

  // Has the customer mentioned a product?
  const customerType = hasCustomerType(customerText);
  const productKnown = !!(currentIntent && currentIntent.productQuery);
  const qtyKnown = !!(currentIntent && currentIntent.quantity) || hasQuantity(customerText);

  // Product + qty + branding mentioned, but customer type missing? → AWAITING_CUSTOMER_TYPE
  if (productKnown && qtyKnown && !customerType) {
    return _stateOf('AWAITING_CUSTOMER_TYPE', { reason: 'Product + qty known, type unknown (RULE F)' });
  }

  // Product + type known, qty missing? → AWAITING_QUANTITY
  if (productKnown && customerType && !qtyKnown) {
    return _stateOf('AWAITING_QUANTITY', { reason: 'Product + customer type known, quantity missing' });
  }

  // Customer named a category, but engine returned multiple matches and no
  // qty/type yet? → AWAITING_PRODUCT_DISAMBIGUATION (only when intent flagged ambiguous)
  if (currentIntent && currentIntent._engineSaidAmbiguous) {
    return _stateOf('AWAITING_PRODUCT_DISAMBIGUATION', { reason: 'Multiple SKUs match customer query' });
  }

  // Customer mentioned a product but no other facts? → QUALIFYING_PRODUCT
  if (productKnown) {
    return _stateOf('QUALIFYING_PRODUCT', { reason: 'Product mentioned, still qualifying' });
  }

  // Default: greeting / no product yet
  return _stateOf('GREETING', { reason: 'No product context yet' });
}

function _stateOf(code, meta = {}) {
  const state = STATES[code];
  if (!state) {
    return { state: STATES.GREETING, reason: 'Unknown state code, defaulting to GREETING' };
  }
  return {
    state,
    code: state.code,
    canBotQuote: state.canBotQuote,
    allowedActions: state.allowedActions,
    guard: state.guard,
    reason: meta.reason || '',
    facts: meta.facts || {}
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public helpers for tests + Phase B.2 integration
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Async state derivation
// ─────────────────────────────────────────────────────────────────────
// Since the LLM-first intent resolver (2026-07-05 spec) supplies customerType
// directly on the intent, the old LLM-classifier fallback branch is dead code
// — deriveState alone is sufficient. The async signature is kept so server.js
// call sites don't change.
async function deriveStateAsync(conversation, currentIntent = null, phone = null) { // eslint-disable-line no-unused-vars
  return deriveState(conversation, currentIntent);
}

module.exports = {
  STATES,
  deriveState,
  deriveStateAsync,
  // exports used by tests
  hasCustomerType,
  hasQuantity,
  hasInvoiceField,
  botHasSharedQuote,
  botSharedPaymentBlock,
  customerAgreedToProceed,
  escalationActive,
  customerPaymentConfirmed
};
