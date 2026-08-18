// enforce() used to act on a premise it never verified.
//
// The READY_TO_QUOTE / AWAITING_BRANDING / QUOTE_PRESENTED cases deliberately
// skip price checks, and the code comments say why: "the [VERIFIED QUOTE]
// block constrains the LLM enough". That is an assumption about the CALLER —
// that an engine quote was computed and injected into the prompt. enforce()
// never checked whether it was true.
//
// Whenever it is false, the LLM is free to state any figure and nothing
// looks at it:
//   - INTENT_RESOLVER=regex (the kill-switch) — the regex path usually
//     yields quantity: null, so computeQuote is never called
//   - the customer has not given a quantity yet
//   - the catalogue lookup was ambiguous ('coasters' → 36 matches)
//   - the resolver timed out or Groq was down
//
// Patching any one of those paths would be a bandage. The fix is to enforce
// the premise itself: a price may only be stated when there is a verified
// quote to check it against. Every path above then collapses into the same
// safe case automatically, including paths not yet thought of.

const { enforce } = require('../pricing/state-enforcer');
const { computeQuote } = require('../pricing/quote-engine');

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const QUOTE = computeQuote({
  productQuery: 'square coaster',
  quantity: 100,
  customerType: 'reseller'
});

const FABRICATED = 'Sure! That will be ₹9,999 total.';

describe('preconditions', () => {
  test('the reference quote resolves', () => {
    expect(QUOTE.found).toBe(true);
  });
});

describe('a price stated with NO verified quote is blocked, in every state', () => {
  // These are precisely the states that skip price checks on the assumption
  // that a verified quote is doing the constraining.
  test.each(['READY_TO_QUOTE', 'AWAITING_BRANDING', 'QUOTE_PRESENTED'])(
    '%s blocks an unverifiable price',
    (code) => {
      const result = enforce({ code, reason: 'test' }, FABRICATED);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('unverified_price');
      expect(result.reply).not.toContain('9,999');
      expect(result.originalReply).toBe(FABRICATED);
    }
  );

  test('an unknown/fallback state also blocks it (default case must not be a hole)', () => {
    const result = enforce({ code: 'UNKNOWN', reason: 'test' }, FABRICATED);
    expect(result.allowed).toBe(false);
    expect(result.reply).not.toContain('9,999');
  });

  test('quote present but found:false counts as no quote', () => {
    // computeQuote returns { found: false } for ambiguous or missing
    // products — that must not be mistaken for a usable quote.
    const result = enforce({ code: 'READY_TO_QUOTE', reason: 'test' }, FABRICATED, {
      quote: { found: false, error: 'multiple_matches' }
    });
    expect(result.allowed).toBe(false);
    expect(result.reply).not.toContain('9,999');
  });

  test('the replacement reply never contains any rupee figure of its own', () => {
    const result = enforce({ code: 'READY_TO_QUOTE', reason: 'test' }, FABRICATED);
    expect(result.reply).not.toMatch(/₹/);
  });
});

describe('verified-quote behaviour is unchanged', () => {
  test('correct engine figures still pass through untouched', () => {
    const good = `For 100 SQUARE COASTER: ₹${QUOTE.perPiece} per piece. Total ₹${QUOTE.grandTotal.toLocaleString('en-IN')} incl. GST.`;
    const result = enforce({ code: 'QUOTE_PRESENTED', reason: 'test' }, good, { quote: QUOTE });

    expect(result.allowed).toBe(true);
    expect(result.reply).toBe(good);
  });

  test('a fabricated figure against a real quote is still a fabricated_amount, repaired from the engine', () => {
    const result = enforce({ code: 'QUOTE_PRESENTED', reason: 'test' }, FABRICATED, { quote: QUOTE });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('fabricated_amount');
    // Repaired with the real total, not the generic no-quote message.
    expect(result.reply).toContain(QUOTE.grandTotal.toLocaleString('en-IN'));
  });
});

describe('non-price replies are never affected', () => {
  test.each([
    ['READY_TO_QUOTE', 'How many pieces are you looking at?'],
    ['QUOTE_PRESENTED', 'I completely understand — what range did you have in mind?'],
    ['GREETING', 'Welcome to 9 Cork! What brings you here today?'],
  ])('%s passes a reply with no amount', (code, reply) => {
    const result = enforce({ code, reason: 'test' }, reply);
    expect(result.allowed).toBe(true);
    expect(result.reply).toBe(reply);
  });

  test('a bare amount without an assertion word is not treated as a quote', () => {
    const reply = 'Our range starts around ₹1,200 depending on the model.';
    const result = enforce({ code: 'READY_TO_QUOTE', reason: 'test' }, reply);
    expect(result.allowed).toBe(true);
  });
});

describe('state-specific canned replies are still preferred where they exist', () => {
  test('AWAITING_QUANTITY uses its own canned question, not the generic one', () => {
    const result = enforce({ code: 'AWAITING_QUANTITY', reason: 'test' }, FABRICATED);
    expect(result.allowed).toBe(false);
    expect(result.reply).toMatch(/how many pieces/i);
  });
});
