// Canonical rupee-amount parsing — the single source of truth for
// "what money appears in this text".
//
// Before this module the codebase carried seven-plus independent ₹-matching
// regexes, and four of them wrote the number part as `\d{2,}` or `\d+`.
// Those forms stop at the first comma, so in Indian digit grouping they
// silently fail on every amount from ₹1,000 up — precisely the bulk-order
// range this business quotes in. The worst case was the outbound price
// guard: it could not see a fabricated "₹9,999 total" at all.
//
// The fix is structural rather than a wider regex in each place: callers
// never write the number pattern themselves. They either call a predicate
// here, or compose RUPEE_AMOUNT_SOURCE, so a comma-blind variant cannot be
// reintroduced in one call site while the others stay correct.

// The number portion of a rupee amount: digits with optional Indian comma
// grouping (1,575 / 1,26,900) and an optional decimal tail.
const RUPEE_AMOUNT_SOURCE = '[\\d,]+(?:\\.\\d+)?';

// A full rupee amount, capturing the number portion in group 1.
// Built fresh per call — a shared /g regex carries lastIndex between calls.
function rupeeAmountRegex() {
  return new RegExp(`₹\\s*(${RUPEE_AMOUNT_SOURCE})`, 'g');
}

/**
 * Parse a rupee number string ("1,26,900") into a Number (126900).
 * @returns {number|null} null when the input is not a usable number.
 */
function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/,/g, '').trim();
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every rupee amount in the text, in order of appearance.
 * @returns {number[]}
 */
function extractRupeeAmounts(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const re = rupeeAmountRegex();
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseAmount(m[1]);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * Does the text state a rupee amount of at least `minValue`?
 *
 * minValue exists so callers can express "a real price, not a stray digit"
 * as an explicit threshold rather than smuggling it into a regex as a digit
 * count — the mistake that made the old `\d{2,}` form comma-blind.
 */
function hasRupeeAmount(text, minValue = 0) {
  return extractRupeeAmounts(text).some(n => n >= minValue);
}

/**
 * A customer-stated budget: "under ₹10,000", "below Rs 500", "around 2,500".
 *
 * Lives here rather than in server.js because it is pure money parsing with
 * no I/O. Keeping it in server.js meant a six-line string function could only
 * be tested by importing a 4,000-line module that calls process.exit(1) when
 * required env vars are absent — so the test passed locally (a gitignored
 * .env supplied them via dotenv) and killed the Jest worker in CI.
 *
 * @returns {number|null} the amount, or null when no budget is stated.
 */
function parseBudget(text) {
  if (!text) return null;
  const re = new RegExp(
    `\\b(?:below|under|around|budget)\\s*(?:rs\\.?|₹)?\\s*(${RUPEE_AMOUNT_SOURCE})`,
    'i'
  );
  const m = String(text).match(re);
  return m ? parseAmount(m[1]) : null;
}

// No single cork product costs anywhere near this per piece (the dearest is
// about ₹7,500). A "price" above it is a parse artifact, not a price. Used as
// a backstop for malformed cells whose shape we have not seen before.
const MAX_PLAUSIBLE_UNIT_PRICE = 1000000;

/**
 * Parse a price cell from a Google Sheet.
 *
 * Sheet cells are not always one number. CORK YOGA PEANUT ships in three
 * sizes and the sheet encodes that as a single cell — DIMENSION "S,M,L",
 * PRICE "583,750,916". Stripping non-digits reads that as 583 million, and
 * it reached production (₹35,04,50,550 on the live product).
 *
 * Comma-stripping is right for "3,317" and wrong for "583,750,916", and the
 * two are syntactically identical — both are validly grouped numbers. Syntax
 * cannot separate them, so the variant count from the DIMENSION column is the
 * disambiguating signal.
 *
 * We never pick one variant on the customer's behalf: an ambiguous row is
 * rejected and reported, matching the importer's rule that it never invents
 * a price.
 *
 * @param {string} raw            the price cell
 * @param {object} [opts]
 * @param {number} [opts.variantCount] how many variants the row declares
 * @returns {{ok: true, value: number} | {ok: false, reason: string}}
 */
function parseSheetPrice(raw, opts = {}) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  const s = String(raw).trim();
  if (!s) return { ok: false, reason: 'empty' };

  // Multi-variant cell: one comma-separated group per declared variant.
  const variantCount = Number(opts.variantCount) || 0;
  if (variantCount > 1) {
    const groups = s.split(',').map(g => g.trim()).filter(Boolean);
    if (groups.length === variantCount && groups.every(g => /^\d+(\.\d+)?$/.test(g))) {
      return {
        ok: false,
        reason: `multi-variant price cell (${groups.length} values for ${variantCount} variants): "${s}" — split the variants into separate rows`
      };
    }
  }

  // A hyphen means a negative or a range ("22-24"). Stripping it would
  // silently concatenate a range into 2224, so reject rather than guess.
  if (/-/.test(s)) return { ok: false, reason: 'negative or range, not a single price' };

  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'not_a_number' };
  if (n > MAX_PLAUSIBLE_UNIT_PRICE) {
    return { ok: false, reason: `implausible unit price ${n} — likely several values in one cell` };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

module.exports = {
  RUPEE_AMOUNT_SOURCE,
  MAX_PLAUSIBLE_UNIT_PRICE,
  parseAmount,
  extractRupeeAmounts,
  hasRupeeAmount,
  parseBudget,
  parseSheetPrice
};
