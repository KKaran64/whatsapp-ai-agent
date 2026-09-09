// State Enforcer — v61 Phase B.2
//
// Post-LLM validator + canned-response fallback. Reads the conversation state
// (from conversation-state.js) and checks whether the LLM's generated reply
// is allowed in that state. If the LLM violated the state's constraints,
// replaces the reply with a state-appropriate canned response.
//
// This is the layer that turns the state machine from advisory (B.1) to
// authoritative (B.2). The LLM still produces the language, but if it tries
// to do something it shouldn't (quote during AWAITING_CUSTOMER_TYPE, ask for
// company name during QUALIFYING_PRODUCT, etc.), the enforcer intercepts and
// substitutes the correct response.
//
// PHILOSOPHY:
//   The LLM is the language layer. The state machine is the process layer.
//   When they disagree, the state machine wins. Predictability over fluency.

const { STATES } = require('./conversation-state');

// ─────────────────────────────────────────────────────────────────────
// Violation detectors
// ─────────────────────────────────────────────────────────────────────
// Each returns true if the reply violates the constraint for its state.

// "Did the LLM quote a price?" — i.e. mention an actual rupee amount
// alongside a product or quantity context.
function botQuotedPrice(text) {
  if (!text) return false;
  // ₹ followed by digits + "per piece" / "total" / "incl" patterns
  return /₹\s*\d{2,}/.test(text) && /\b(per|total|incl|each)\b/i.test(text);
}

// "Did the LLM list multiple products with prices?" — common when state says
// AWAITING_PRODUCT_DISAMBIGUATION (we want just names, not a price list)
function botListedProductsWithPrices(text) {
  if (!text) return false;
  const pricePoints = (text.match(/₹\s*\d{2,}/g) || []).length;
  const productCues = (text.match(/\b\d+\.\s|•\s|–\s/g) || []).length;
  return pricePoints >= 2 && (productCues >= 2 || /\boptions?\b/i.test(text));
}

// "Did the LLM ask for invoice fields?" — company name, GSTIN, address
function botAskedInvoiceField(text) {
  if (!text) return false;
  return /\b(company name|registered company|gst(?:in)? number|gstin|billing address|shipping address|contact person|complete address)\b/i.test(text);
}

// "Did the LLM share payment details?" — bank account, IFSC, payment block
function botSharedPaymentBlock(text) {
  if (!text) return false;
  return /\b(canara bank|cnrb0007617|120032289098|account no|ifsc|bank details|payment screenshot)\b/i.test(text);
}

// "Did the LLM ask for customer type?" — the RULE F question
function botAskedCustomerType(text) {
  if (!text) return false;
  return /\b(own use|for resale|reselling|corporate gifting|hotel,? office)\b/i.test(text);
}

// "Did the LLM mention a discount % or MRP?" — should never appear in final reply
function botExposedPricingStrategy(text) {
  if (!text) return false;
  return /\b\d+(?:\.\d+)?\s*%\s*(?:off|discount)\b/i.test(text)
    || /\bMRP\s+₹/i.test(text)
    || /\b(?:reseller|end consumer)\s+(?:slab|tier)\b/i.test(text);
}

// ─────────────────────────────────────────────────────────────────────
// Canned responses per state (substitute when LLM violates)
// ─────────────────────────────────────────────────────────────────────
// These are deliberately short + warm. The enforcer uses them as fallbacks
// when the LLM produced an inappropriate response for the current state.

const CANNED = {
  GREETING:
    "👋 Welcome to 9 Cork! What brings you here today — corporate gifting, your business, or personal use?",

  QUALIFYING_PRODUCT:
    "What kind of product are you interested in? We have diaries, coasters, planters, frames, trays, bags, and more.",

  AWAITING_CUSTOMER_TYPE:
    "Sure, happy to help! Could you let me know if these are for your own use (corporate gifting, hotel, office, personal) or for resale?",

  AWAITING_QUANTITY:
    "Got it! How many pieces are you looking at?",

  AWAITING_PRODUCT_DISAMBIGUATION:
    "We have a few options that match — could you let me know which one you're interested in?",

  AWAITING_BRANDING:
    "Would you like branding? We offer single-color screen/pad printing, multi-color UV/DTF, or laser engraving.",

  COLLECTING_INVOICE_INFO:
    "Great! To prepare your invoice, could you share your registered company name?",

  AWAITING_PAYMENT:
    "Just a reminder — please share the payment screenshot once done, and we'll process your order!",

  POST_SALE:
    "Thanks! Your order is being processed. If happy with the service, we'd appreciate a quick review 🌿"
};

// ─────────────────────────────────────────────────────────────────────
// Main enforce() — the public API
// ─────────────────────────────────────────────────────────────────────
//
// Returns either { allowed: true, reply } (LLM reply is fine, pass through)
// OR { allowed: false, reply, reason, originalReply } (LLM violated, replaced).

// Strip pricing-strategy phrases from a reply (in-place, surgical).
// Used when the LLM exposed discount %/MRP/slab — we'd rather keep the
// surrounding sentence and remove the strategic-info phrase than replace
// the whole reply with a generic canned message.
function stripPricingStrategy(text) {
  let out = text;
  // "at 12.5% off MRP ₹225" / "12.5% off" / "(30% off)"
  out = out.replace(/\s*(?:\(|,|at)\s*\d+(?:\.\d+)?\s*%\s*(?:off|discount)(?:\s+MRP)?(?:\s+₹\s*[\d,]+(?:\.\d+)?)?(?:\)|,)?/gi, '');
  // " MRP ₹225"
  out = out.replace(/\s*MRP\s+₹\s*[\d,]+(?:\.\d+)?/gi, '');
  // "Since you're a reseller, I'll apply the reseller slab."
  out = out.replace(/\s*Since you'?re a (?:reseller|end consumer|business)[,.]?\s*(?:I'?ll\s+apply\s+the\s+(?:reseller|end consumer|customer)?\s*(?:discount\s+)?slab\.?)?/gi, '');
  out = out.replace(/\s*I'?ll\s+apply\s+the\s+(?:reseller|end consumer|customer)?\s*(?:discount\s+)?slab\.?/gi, '');
  // "(reseller slab)" / "(end consumer slab)"
  out = out.replace(/\s*(?:reseller|end consumer)\s+(?:discount\s+)?slab\b\.?/gi, '');
  // Collapse whitespace + orphan punctuation
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Outbound numeric guard (2026-07-06 incident)
// ─────────────────────────────────────────────────────────────────────
// The Single-Brain invariant — numbers reaching the customer come ONLY from
// the engine — was enforced inbound (prompt instruction) but never outbound.
// Under negotiation pressure the LLM recomputed 300×423 = ₹1,26,900 and
// mislabeled it "incl. GST". This guard closes the invariant by construction:
// when an engine quote is active for the turn, every ₹ amount in the reply
// must be one of the quote's customer-facing figures.
function extractRupeeAmounts(text) {
  const out = [];
  const re = /₹\s*([\d,]+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function allowedQuoteAmounts(quote) {
  const allowed = new Set([quote.perPiece, quote.grandTotal]);
  if (quote.branding) {
    allowed.add(quote.branding.ratePerPc);
    allowed.add(quote.branding.setupFee);
  }
  if (quote.packaging && quote.packaging.applied) {
    allowed.add(quote.packaging.ratePerPc);
    allowed.add(quote.packaging.subtotalEx);
  }
  return allowed;
}

function findFabricatedAmounts(text, quote) {
  const allowed = allowedQuoteAmounts(quote);
  return extractRupeeAmounts(text).filter(n => !allowed.has(n));
}

function enforce(stateResult, llmReply, options = {}) {
  if (!stateResult || !llmReply) {
    return { allowed: true, reply: llmReply };
  }

  const stateCode = stateResult.code;
  const violations = [];

  // ── Universal violation: fabricated ₹ amount ──
  // Checked first and repaired deterministically from the engine quote —
  // a wrong number must never reach the customer, whatever the state.
  const quote = options.quote;
  if (quote && quote.found) {
    const fabricated = findFabricatedAmounts(llmReply, quote);
    if (fabricated.length > 0) {
      const { formatQuoteForCustomer } = require('./quote-engine');
      return {
        allowed: false,
        reply: `Apologies, let me restate the exact figures. ${formatQuoteForCustomer(quote)}`,
        reason: `fabricated_amount: ₹${fabricated.join(', ₹')} not in engine quote`,
        originalReply: llmReply
      };
    }
  }

  // ── Universal violation: pricing strategy exposure ──
  // For this one we don't replace the whole reply — we strip the offending
  // phrases surgically and pass the rest through. This preserves correct
  // surrounding text while removing the leak.
  let replyAfterStrip = llmReply;
  if (botExposedPricingStrategy(llmReply)) {
    replyAfterStrip = stripPricingStrategy(llmReply);
    violations.push('exposed_pricing_strategy_stripped');
    // If after stripping we still have a usable reply (> 20 chars), continue
    // checking state-specific violations on the stripped version. Otherwise
    // fall through to a canned response.
  }

  // ── State-specific violations ──
  switch (stateCode) {
    case 'GREETING':
    case 'QUALIFYING_PRODUCT':
      // No quoting allowed yet
      if (botQuotedPrice(llmReply)) violations.push('quoted_too_early');
      if (botAskedInvoiceField(llmReply)) violations.push('asked_invoice_too_early');
      if (botSharedPaymentBlock(llmReply)) violations.push('shared_payment_too_early');
      break;

    case 'AWAITING_CUSTOMER_TYPE':
      // Block forbidden actions (quoting/invoice/payment) — but do NOT force
      // the canned RULE-F question onto every reply: the customer may have
      // asked a side question ("what's your website?") that deserves a real
      // answer. The [CONVERSATION STATE] guard already instructs the LLM to
      // ask for customer type; enforcement here is for violations only.
      if (botQuotedPrice(llmReply)) violations.push('quoted_before_customer_type');
      if (botAskedInvoiceField(llmReply)) violations.push('skipped_to_invoice');
      if (botSharedPaymentBlock(llmReply)) violations.push('skipped_to_payment');
      break;

    case 'AWAITING_QUANTITY':
      if (botQuotedPrice(llmReply)) violations.push('quoted_before_quantity');
      if (botAskedInvoiceField(llmReply)) violations.push('skipped_to_invoice');
      break;

    case 'AWAITING_PRODUCT_DISAMBIGUATION':
      if (botQuotedPrice(llmReply)) violations.push('quoted_before_sku_chosen');
      if (botListedProductsWithPrices(llmReply)) violations.push('listed_products_with_prices');
      break;

    case 'AWAITING_BRANDING':
      // Branding question expected; quotes okay only if engine provided a [VERIFIED QUOTE]
      // (which the LLM should pass through). Pure-LLM-generated quotes are a violation.
      break;

    case 'READY_TO_QUOTE':
      // Engine has produced a verified quote — LLM should present it. No violations
      // to enforce here; the [VERIFIED QUOTE] block constrains the LLM enough.
      break;

    case 'QUOTE_PRESENTED':
      // Customer is deciding — bot shouldn't re-quote unprompted or jump ahead to invoice
      if (botSharedPaymentBlock(llmReply)) violations.push('shared_payment_too_early');
      break;

    case 'COLLECTING_INVOICE_INFO':
      // Should be asking for the next invoice field; no quoting / payment
      if (botSharedPaymentBlock(llmReply)) {
        // Only allowed if ALL invoice fields are collected — we can't verify
        // here, so trust the state derivation. If state is still COLLECTING,
        // the derivation thinks fields are missing → payment block is too early.
        violations.push('shared_payment_before_invoice_complete');
      }
      break;

    case 'AWAITING_PAYMENT':
      // Bot should be waiting for screenshot, not re-quoting or re-asking
      if (botQuotedPrice(llmReply) && !/\btotal\s+(?:was|of|came)\b/i.test(llmReply)) {
        // Allow polite reminder of total, but no new quotes
        violations.push('re_quoted_after_payment_block');
      }
      if (botAskedInvoiceField(llmReply)) violations.push('re_asked_invoice_after_payment');
      break;

    case 'ESCALATED':
      // Escalation is open — bot can continue normal flow but can't substitute
      // a quote for the specialty ask that triggered the escalation.
      break;

    case 'POST_SALE':
      // Order done; minimal interference
      break;

    default:
      // Unknown state — pass through
      break;
  }

  // If the only violation was pricing-strategy exposure (which we stripped),
  // the reply might be salvageable — return the stripped version.
  const onlyStrategyViolation = violations.length === 1 && violations[0] === 'exposed_pricing_strategy_stripped';
  if (onlyStrategyViolation && replyAfterStrip.length >= 20) {
    return {
      allowed: true,
      reply: replyAfterStrip,
      stripped: true,
      reason: 'pricing strategy phrases removed from reply',
      originalReply: llmReply
    };
  }

  if (violations.length === 0) {
    return { allowed: true, reply: llmReply };
  }

  // Choose a canned fallback based on the state
  const canned = CANNED[stateCode];
  if (canned) {
    return {
      allowed: false,
      reply: canned,
      reason: violations.join(', '),
      originalReply: llmReply
    };
  }

  // No canned fallback for this state — at least return the stripped version
  // if we did any stripping. Otherwise pass through with a warning.
  if (replyAfterStrip !== llmReply) {
    return {
      allowed: true,
      reply: replyAfterStrip,
      stripped: true,
      reason: 'pricing strategy phrases removed from reply',
      originalReply: llmReply
    };
  }
  console.warn(`⚠️ State enforcer: ${stateCode} violations [${violations.join(', ')}] but no canned fallback`);
  return { allowed: true, reply: llmReply, warnings: violations };
}

module.exports = {
  enforce,
  CANNED,
  // exports for testing
  botQuotedPrice,
  botListedProductsWithPrices,
  botAskedInvoiceField,
  botSharedPaymentBlock,
  botAskedCustomerType,
  botExposedPricingStrategy,
  extractRupeeAmounts,
  findFabricatedAmounts
};
