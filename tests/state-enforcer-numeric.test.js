// Outbound numeric guard — reproduction of the 2026-07-06 live incident:
//
//   customer: "i am getting better from other companies / this is very high"
//   bot:      "...For your 300 RUBBERIZED DESKTOP MAT: ₹423 per piece, the
//              total would come out to ₹1,26,900 incl. GST..."
//
// ₹1,26,900 is 300 × 423 — the EX-GST subtotal. The LLM recomputed the total
// itself under negotiation pressure and mislabeled it "incl. GST". The
// correct incl-GST total was ₹1,33,245. Nothing validated outbound ₹ amounts
// against the engine quote, so a fabricated number reached a customer.
//
// The guard's invariant: when an engine quote is active for the turn, every
// ₹ amount in the outbound reply must belong to the quote's customer-facing
// figures (per-piece, grand total, branding rate/setup). Anything else is a
// fabricated_amount violation → deterministic repair from the engine.

const { enforce } = require('../pricing/state-enforcer');
const { computeQuote } = require('../pricing/quote-engine');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

const QUOTE_PRESENTED_STATE = { code: 'QUOTE_PRESENTED', reason: 'test' };

// Real engine quote from the real catalog — the same product as the incident.
const quote = computeQuote({
  productQuery: 'desktop mat',
  quantity: 300,
  customerType: 'end_consumer'
});

const inr = n => n.toLocaleString('en-IN');

describe('guard preconditions (uses the real catalog)', () => {
  test('the incident quote resolves and has distinct subtotal vs grand total', () => {
    expect(quote.found).toBe(true);
    expect(quote.productSubtotalEx).not.toBe(quote.grandTotal);
  });
});

describe('fabricated_amount violation', () => {
  test('BLOCKS the live-incident reply (ex-GST subtotal mislabeled incl. GST)', () => {
    const fabricated = `I completely understand that you're looking for the best option. For your ${quote.quantity} ${quote.product.name}: ₹${inr(quote.perPiece)} per piece, the total would come out to ₹${inr(quote.productSubtotalEx)} incl. GST. Would you like to proceed?`;

    const result = enforce(QUOTE_PRESENTED_STATE, fabricated, { quote });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('fabricated_amount');
    // The repaired reply must carry the CORRECT total and not the fabricated one
    expect(result.reply).toContain(inr(quote.grandTotal));
    expect(result.reply).not.toContain(inr(quote.productSubtotalEx));
    expect(result.originalReply).toBe(fabricated);
  });

  test('blocks an invented discount figure', () => {
    const reply = `Since you're comparing options, I can do ₹${inr(quote.perPiece - 50)} per piece for you!`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply, { quote });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('fabricated_amount');
  });
});

describe('legitimate replies pass through', () => {
  test('exact engine numbers are allowed', () => {
    const reply = `For ${quote.quantity} ${quote.product.name}: ₹${inr(quote.perPiece)} per piece. Total ₹${inr(quote.grandTotal)} incl. GST. Would you like to proceed?`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply, { quote });
    expect(result.allowed).toBe(true);
    expect(result.reply).toBe(reply);
  });

  test('spacing and comma variants of allowed amounts are fine', () => {
    const reply = `That's ₹ ${quote.perPiece} per piece, ₹${inr(quote.grandTotal)} all-inclusive.`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply, { quote });
    expect(result.allowed).toBe(true);
  });

  test('a pure-empathy objection reply with no amounts is untouched', () => {
    const reply = `I completely understand — let me see what I can do to help. May I ask what price range you had in mind?`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply, { quote });
    expect(result.allowed).toBe(true);
    expect(result.reply).toBe(reply);
  });

  test('guard is inactive when no quote context is provided (legacy behavior)', () => {
    const reply = `The total is ₹9,99,999 incl. GST.`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply);
    expect(result.allowed).toBe(true);
  });
});

describe('branding figures', () => {
  const brandedQuote = computeQuote({
    productQuery: 'desktop mat',
    quantity: 300,
    customerType: 'end_consumer',
    branding: 'laser'
  });

  test('branding per-piece rate is an allowed amount', () => {
    expect(brandedQuote.found).toBe(true);
    const reply = `For ${brandedQuote.quantity} ${brandedQuote.product.name} with laser engraving: ₹${inr(brandedQuote.perPiece)} per piece. Branding: ₹${brandedQuote.branding.ratePerPc} per piece. Total ₹${inr(brandedQuote.grandTotal)} incl. GST.`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply, { quote: brandedQuote });
    expect(result.allowed).toBe(true);
  });
});

describe('packaging figures', () => {
  const boxedQuote = computeQuote({
    productQuery: 'small magnetic planter',
    quantity: 400,
    customerType: 'reseller',
    packaging: 'individual_boxes'
  });

  test('box rate and box subtotal are allowed amounts', () => {
    expect(boxedQuote.found).toBe(true);
    expect(boxedQuote.packaging.applied).toBe(true);
    const reply = `For ${boxedQuote.quantity} ${boxedQuote.product.name}: ₹${boxedQuote.perPiece} per piece. Individual boxes: ₹${boxedQuote.packaging.ratePerPc} per piece (₹${boxedQuote.packaging.subtotalEx.toLocaleString('en-IN')} for boxes). Total ₹${boxedQuote.grandTotal.toLocaleString('en-IN')} incl. GST.`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply, { quote: boxedQuote });
    expect(result.allowed).toBe(true);
  });

  test('a fabricated box rate is blocked', () => {
    const reply = `Individual boxes are just ₹15 per piece extra!`;
    const result = enforce(QUOTE_PRESENTED_STATE, reply, { quote: boxedQuote });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('fabricated_amount');
  });
});
