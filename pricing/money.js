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

module.exports = {
  RUPEE_AMOUNT_SOURCE,
  parseAmount,
  extractRupeeAmounts,
  hasRupeeAmount
};
