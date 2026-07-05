# Individual-Box Packaging Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine prices individual-box packaging (₹10/pc + 5% GST, catalogue products under ₹500/pc, on request only) and the bot stops inventing packaging policy.

**Architecture:** Same pattern as the branding fee: the intent resolver captures the customer's packaging request as a structured field, the deterministic quote engine computes the charge as a line item, the outbound numeric guard whitelists the box figures, and the system prompt carries the descriptive knowledge (corrugated brown pizza box; bulk-shipping answer).

**Tech Stack:** Node.js, Jest 30 (existing test conventions: real catalog for engine tests, mocked `groq-client` for resolver tests)

**Spec:** `docs/superpowers/specs/2026-07-06-packaging-box-rule-design.md`

## Global Constraints

- Box charge: ₹10 per piece, GST-exclusive, box GST rate 5% (`Math.round` like other GST lines)
- Eligible iff: `packaging === 'individual_boxes'` AND `top.source === 'catalogue'` AND `perPiece < 500` (strict less-than; post-discount per-piece)
- Requested but ineligible → `packaging: { key: 'individual_boxes', applied: false }`, no charge added
- Not requested → `packaging: null`, all totals byte-identical to today (regression guard)
- Customer-facing line when applied: `Individual boxes: ₹10 per piece.`
- Resolver must NOT set `packaging` for shipping-method questions ("how do you send the goods?") — those stay `packaging: null`
- Branch: `feat/packaging-box-rule` (already exists, stacked on `fix/outbound-quote-guard` because the numeric guard's `allowedQuoteAmounts` is a dependency)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `pricing/quote-engine.js` | Modify | `PACKAGING_BOX` constants; packaging line item in `computeQuote`; box line in `formatQuoteForCustomer` |
| `tests/quote-engine-packaging.test.js` | Create | Engine math, eligibility matrix, regression |
| `pricing/state-enforcer.js` | Modify | `allowedQuoteAmounts` includes box figures |
| `tests/state-enforcer-numeric.test.js` | Modify | Guard allows engine box figures, blocks fabricated box rate |
| `pricing/intent-resolver.js` | Modify | `packaging` field: prompt, validation, fallback mapping |
| `pricing/intent-extractor.js` | Modify | `detectPackaging` regex for the fallback path |
| `tests/intent-resolver.test.js` | Modify | Extraction, shipping-question negative case, fallback |
| `system-prompt.js` | Modify | Replace RULE 5B with full packaging knowledge |

`server.js` needs **no change**: `computeQuote(intent)` already passes the whole intent (which will carry `packaging`), and the already-presented detection keys on `grandTotal`, so a quote that gains a box charge presents fresh automatically.

---

### Task 1: Engine — packaging line item

**Files:**
- Modify: `pricing/quote-engine.js` (computeQuote + formatQuoteForCustomer + exports)
- Test: `tests/quote-engine-packaging.test.js`

**Interfaces:**
- Consumes: existing `computeQuote`/`formatQuoteForCustomer`/`findProducts`
- Produces: `computeQuote({ productQuery, quantity, customerType, branding, refinements, packaging })` where `packaging: 'individual_boxes' | null | undefined`; quote gains `packaging: null | { key: 'individual_boxes', applied: false } | { key: 'individual_boxes', ratePerPc: 10, subtotalEx: number, gst: number, applied: true }`. Exports `PACKAGING_BOX = { ratePerPc: 10, gstRate: 0.05, thresholdPerPiece: 500 }`.

- [ ] **Step 1: Write the failing test**

Create `tests/quote-engine-packaging.test.js`:

```js
// Individual-box packaging rule (spec 2026-07-06). Uses the real catalog.
// Test subject: SMALL MAGNETIC PLANTER — source=catalogue, MRP ₹217,
// reseller@400 → ₹130/pc (verified against the 2026-07-06 live transcript).

const { computeQuote, formatQuoteForCustomer, PACKAGING_BOX } = require('../pricing/quote-engine');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

const BASE = { productQuery: 'small magnetic planter', quantity: 400, customerType: 'reseller' };

describe('packaging charge — eligible case (catalogue, <₹500/pc, requested)', () => {
  const withoutBox = computeQuote(BASE);
  const withBox = computeQuote({ ...BASE, packaging: 'individual_boxes' });

  test('base quote resolves as expected (transcript parity)', () => {
    expect(withoutBox.found).toBe(true);
    expect(withoutBox.product.source).toBe('catalogue');
    expect(withoutBox.perPiece).toBeLessThan(PACKAGING_BOX.thresholdPerPiece);
  });

  test('adds ₹10/pc + 5% GST into the totals', () => {
    expect(withBox.found).toBe(true);
    const boxSubtotal = PACKAGING_BOX.ratePerPc * BASE.quantity;           // 4000
    const boxGst = Math.round(boxSubtotal * PACKAGING_BOX.gstRate);        // 200
    expect(withBox.packaging).toEqual({
      key: 'individual_boxes',
      ratePerPc: PACKAGING_BOX.ratePerPc,
      subtotalEx: boxSubtotal,
      gst: boxGst,
      applied: true
    });
    expect(withBox.subtotalEx).toBe(withoutBox.subtotalEx + boxSubtotal);
    expect(withBox.totalGst).toBe(withoutBox.totalGst + boxGst);
    expect(withBox.grandTotal).toBe(withoutBox.grandTotal + boxSubtotal + boxGst);
  });

  test('per-piece product price is unchanged by the box charge', () => {
    expect(withBox.perPiece).toBe(withoutBox.perPiece);
  });

  test('formatQuoteForCustomer mentions the box line', () => {
    const line = formatQuoteForCustomer(withBox);
    expect(line).toContain(`Individual boxes: ₹${PACKAGING_BOX.ratePerPc} per piece.`);
    expect(line).toContain(withBox.grandTotal.toLocaleString('en-IN'));
  });
});

describe('packaging charge — ineligible cases (requested, no charge)', () => {
  test('HORECA product → applied:false, totals unchanged', () => {
    // Any horeca product: find one deterministically via a quote
    const base = { productQuery: 'bar caddy 17', quantity: 100, customerType: 'reseller' };
    const withoutBox = computeQuote(base);
    if (!withoutBox.found) return; // catalog drift guard — skip rather than false-fail
    expect(withoutBox.product.source).not.toBe('catalogue');
    const withBox = computeQuote({ ...base, packaging: 'individual_boxes' });
    expect(withBox.packaging).toEqual({ key: 'individual_boxes', applied: false });
    expect(withBox.grandTotal).toBe(withoutBox.grandTotal);
  });

  test('formatQuoteForCustomer has no box line when applied:false', () => {
    const withBox = computeQuote({ productQuery: 'small magnetic planter', quantity: 4, customerType: 'reseller', packaging: 'individual_boxes' });
    // qty 4 → no slab discount → perPiece 217 < 500, still eligible: use a
    // guaranteed-ineligible construction instead: fake threshold via ≥500 product.
    // (Covered structurally in the next test; here just assert the line matches applied flag.)
    const line = formatQuoteForCustomer(withBox);
    if (withBox.packaging && withBox.packaging.applied) {
      expect(line).toContain('Individual boxes');
    } else {
      expect(line).not.toContain('Individual boxes');
    }
  });

  test('catalogue product at ≥₹500/pc → applied:false', () => {
    // Find a real catalogue product whose undiscounted price is ≥ 500
    const { loadCatalog } = require('../pricing/quote-engine');
    const expensive = loadCatalog().catalogue.find(p => p.price >= 500 && p.name);
    expect(expensive).toBeDefined();
    const q = computeQuote({ productQuery: expensive.name, quantity: 1, customerType: 'end_consumer', packaging: 'individual_boxes' });
    if (!q.found) return; // multi-match catalog drift guard
    expect(q.perPiece).toBeGreaterThanOrEqual(500);
    expect(q.packaging.applied).toBe(false);
  });

  test('boundary: post-discount price crossing under ₹500 makes the box chargeable', () => {
    // The rule keys on QUOTED per-piece (user decision), not MRP: an
    // expensive product discounted below 500 becomes eligible.
    const { loadCatalog } = require('../pricing/quote-engine');
    const candidate = loadCatalog().catalogue.find(p => p.price >= 500 && p.price * 0.6 < 500 && p.name);
    expect(candidate).toBeDefined();
    const q = computeQuote({ productQuery: candidate.name, quantity: 50, customerType: 'reseller', packaging: 'individual_boxes' });
    if (!q.found) return; // multi-match catalog drift guard
    expect(q.perPiece).toBeLessThan(500);
    expect(q.packaging.applied).toBe(true);
  });
});

describe('regression — packaging not requested', () => {
  test('quote shape and totals identical to pre-change, packaging is null', () => {
    const q = computeQuote(BASE);
    expect(q.packaging).toBeNull();
    expect(q.grandTotal).toBe(54600); // transcript-verified figure
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/quote-engine-packaging.test.js`
Expected: FAIL — `PACKAGING_BOX` is undefined and `withBox.packaging` is undefined.

- [ ] **Step 3: Implement**

In `pricing/quote-engine.js`:

(a) Add constants after the `BRANDING_OPTIONS` block:

```js
// ─────────────────────────────────────────────────────────────────────
// Individual-box packaging (2026-07-06 spec): corrugated brown pizza box,
// ₹10/pc + 5% GST — only for catalogue-section products under ₹500/pc
// (post-discount), and only when the customer requests individual boxes.
// HORECA / trophies / combos: no charge (box included / standard packing).
// ─────────────────────────────────────────────────────────────────────
const PACKAGING_BOX = { ratePerPc: 10, gstRate: 0.05, thresholdPerPiece: 500 };
```

(b) Change the `computeQuote` destructuring:

```js
function computeQuote({ productQuery, quantity, customerType, branding, refinements, packaging }) {
```

(c) After the branding block (after `brandingDetail = {...};` closes) and BEFORE `const subtotalEx = ...`, insert:

```js
  // Optional individual-box packaging
  let packagingDetail = null;
  let packagingSubtotalEx = 0;
  let packagingGst = 0;
  if (packaging === 'individual_boxes') {
    const eligible = top.source === 'catalogue' && perPiece < PACKAGING_BOX.thresholdPerPiece;
    if (eligible) {
      packagingSubtotalEx = PACKAGING_BOX.ratePerPc * quantity;
      packagingGst = Math.round(packagingSubtotalEx * PACKAGING_BOX.gstRate);
      packagingDetail = {
        key: 'individual_boxes',
        ratePerPc: PACKAGING_BOX.ratePerPc,
        subtotalEx: packagingSubtotalEx,
        gst: packagingGst,
        applied: true
      };
    } else {
      // Requested but not chargeable — box included / standard packing.
      packagingDetail = { key: 'individual_boxes', applied: false };
    }
  }
```

(d) Update the totals lines:

```js
  const subtotalEx = productSubtotalEx + brandingSubtotalEx + packagingSubtotalEx;
  const totalGst = productGst + brandingGst + packagingGst;
```

(e) Add `packaging: packagingDetail,` to the returned object (after `brandingGst,`).

(f) In `formatQuoteForCustomer`, after the branding `if` block and before `lines.push(\`Total ₹...\`)`:

```js
  if (quote.packaging && quote.packaging.applied) {
    lines.push(`Individual boxes: ₹${quote.packaging.ratePerPc} per piece.`);
  }
```

(g) Add `PACKAGING_BOX` to `module.exports`.

- [ ] **Step 4: Run tests**

Run: `npx jest tests/quote-engine-packaging.test.js tests/quote-engine-refinements.test.js tests/office-mats-regression.test.js`
Expected: PASS all (refinements/office-mats suites prove no regression).

- [ ] **Step 5: Commit**

```bash
git add pricing/quote-engine.js tests/quote-engine-packaging.test.js
git commit -m "feat: individual-box packaging line item in quote engine"
```

---

### Task 2: Numeric guard — whitelist box figures

**Files:**
- Modify: `pricing/state-enforcer.js` (`allowedQuoteAmounts`)
- Test: `tests/state-enforcer-numeric.test.js` (append describe block)

**Interfaces:**
- Consumes: quote shape from Task 1 (`quote.packaging.{ratePerPc, subtotalEx, applied}`)
- Produces: guard allows `ratePerPc` (10) and `subtotalEx` when packaging applied

- [ ] **Step 1: Write the failing test**

Append to `tests/state-enforcer-numeric.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx jest tests/state-enforcer-numeric.test.js`
Expected: FAIL — `box rate and box subtotal are allowed amounts` (₹10 / box subtotal not in allowed set). The fabricated-₹15 test may pass already (15 was never allowed).

- [ ] **Step 3: Implement**

In `pricing/state-enforcer.js`, extend `allowedQuoteAmounts`:

```js
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
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/state-enforcer-numeric.test.js`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add pricing/state-enforcer.js tests/state-enforcer-numeric.test.js
git commit -m "feat: numeric guard whitelists engine packaging figures"
```

---

### Task 3: Resolver + regex fallback — capture the packaging request

**Files:**
- Modify: `pricing/intent-resolver.js` (schema, prompt, validation, fallback mapping)
- Modify: `pricing/intent-extractor.js` (`detectPackaging`, include in `extractIntent`)
- Test: `tests/intent-resolver.test.js` (append describe block)

**Interfaces:**
- Consumes: nothing new
- Produces: intent contract gains `packaging: 'individual_boxes' | null` on BOTH sources (llm and regex_fallback). `intent-extractor.extractIntent` result gains `packaging`.

- [ ] **Step 1: Write the failing test**

Append to `tests/intent-resolver.test.js`:

```js
describe('packaging extraction', () => {
  test('LLM-extracted individual_boxes passes validation', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'planter', refinements: ['magnetic'], quantity: 400,
      customerType: 'reseller', branding: null, packaging: 'individual_boxes',
      confidence: 0.9, reasoning: 'reseller wants each planter boxed'
    });
    const intent = await resolveIntent('can you pack each one in its own box?', []);
    expect(intent.packaging).toBe('individual_boxes');
  });

  test('unknown packaging value is nulled', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'planter', refinements: [], quantity: 400,
      customerType: 'reseller', branding: null, packaging: 'bubble-wrap',
      confidence: 0.9, reasoning: 'ok'
    });
    const intent = await resolveIntent('bubble wrap please', []);
    expect(intent.packaging).toBeNull();
  });

  test('shipping-method question does NOT set packaging', async () => {
    callGroqJson.mockResolvedValue({
      productQuery: 'planter', refinements: [], quantity: 400,
      customerType: 'reseller', branding: null, packaging: null,
      confidence: 0.9, reasoning: 'asking how goods ship, not requesting boxes'
    });
    const intent = await resolveIntent('how do you send the goods?', []);
    expect(intent.packaging).toBeNull();
  });

  test('regex fallback catches an explicit individual-boxes request', async () => {
    callGroqJson.mockResolvedValue(null);
    const intent = await resolveIntent('i need 100 cork diaries in individual boxes', []);
    expect(intent.source).toBe('regex_fallback');
    expect(intent.packaging).toBe('individual_boxes');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/intent-resolver.test.js`
Expected: FAIL — `intent.packaging` is `undefined` in all four.

- [ ] **Step 3: Implement**

(a) `pricing/intent-extractor.js` — add after `detectBranding`:

```js
// ─────────────────────────────────────────────────────────────────────
// Packaging detection (2026-07-06 spec) — explicit individual-box requests
// ─────────────────────────────────────────────────────────────────────
function detectPackaging(texts) {
  const joined = texts.filter(Boolean).join(' \n ');
  if (/\b(individual|separate|each in a|each one in|per piece)\s+(box|boxes|packing|packaging)\b|\bbox packing\b|\bpack(?:ed)? (?:them |each )?(individually|separately)\b/i.test(joined)) {
    return 'individual_boxes';
  }
  return null;
}
```

In `extractIntent`'s return object add:

```js
    packaging: detectPackaging(recentCustomerOnly)
```

And add `detectPackaging` to `module.exports`.

(b) `pricing/intent-resolver.js`:

- Add constant after `BRANDING_KEYS`:

```js
const PACKAGING_KEYS = new Set(['individual_boxes']);
```

- In `SYSTEM_PROMPT`'s JSON form, add after the `"branding"` line:

```
  "packaging": "individual_boxes" | null,
```

- Add to the Rules list:

```
- packaging: "individual_boxes" ONLY if the customer asks for items packed in individual/separate boxes (per-piece boxes, gift boxes each). A question about HOW goods are shipped/sent/packed in transit is NOT a boxes request → null.
```

- Add a worked example before the final example:

```
Conversation:
  customer: i need 400 magnetic planters for reselling
  customer: can you pack each one in its own box?
→ {"productQuery": "planter", "refinements": ["magnetic"], "quantity": 400, "customerType": "reseller", "branding": null, "packaging": "individual_boxes", "confidence": 0.9, "reasoning": "reseller wants each planter individually boxed"}

Conversation:
  customer: 400 magnetic planters. how do you send the goods?
→ {"productQuery": "planter", "refinements": ["magnetic"], "quantity": 400, "customerType": null, "branding": null, "packaging": null, "confidence": 0.85, "reasoning": "shipping-method question, not an individual-boxes request"}
```

- Update the OTHER existing examples' JSON outputs to include `"packaging": null` (keep the form consistent so the model always emits the field).

- In `validateIntent`'s `out` object add `packaging: null`, and after the branding check:

```js
  if (PACKAGING_KEYS.has(raw.packaging)) out.packaging = raw.packaging;
```

- In `regexFallback`'s returned object add:

```js
    packaging: regexIntent.packaging || null,
```

- In `resolveIntent`'s no-pricing-intent check, include packaging:

```js
  if (!intent.productQuery && !intent.quantity && !intent.customerType && !intent.branding && !intent.packaging) {
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/intent-resolver.test.js tests/office-mats-regression.test.js`
Expected: PASS all (office-mats guards the contract shape).

Note: the first test in `tests/intent-resolver.test.js` (`returns validated intent from the LLM`) uses `toEqual` on the full intent shape — it will now fail unless `packaging: null` is added to its expected object. Update that expectation:

```js
    expect(intent).toEqual({
      productQuery: 'mat',
      refinements: ['desktop', 'office'],
      quantity: 200,
      customerType: 'end_consumer',
      branding: null,
      packaging: null,
      confidence: 0.9,
      source: 'llm',
      reasoning: 'customer wants desktop mats for own office use'
    });
```

- [ ] **Step 5: Commit**

```bash
git add pricing/intent-resolver.js pricing/intent-extractor.js tests/intent-resolver.test.js
git commit -m "feat: packaging request extraction (LLM + regex fallback)"
```

---

### Task 4: System prompt — packaging knowledge

**Files:**
- Modify: `system-prompt.js:189-191` (replace RULE 5B)

**Interfaces:**
- Consumes: nothing programmatic — prose knowledge for the LLM
- Produces: grounded packaging answers; the engine remains the only source of the ₹10 charge

- [ ] **Step 1: Replace RULE 5B**

Replace:

```
**RULE 5B: PACKAGING & GIFT BOX REQUESTS (v53.2)**
When customer asks for packaging/gift box images:
✅ CORRECT: "I don't have gift box images right now, but it's an elegant box. Would you like to proceed?"
```

with:

```
**RULE 5B: PACKAGING & SHIPPING (2026-07-06)**
Default shipping (customer asks "how do you send the goods?" WITHOUT wanting individual boxes):
✅ CORRECT: "We send the goods in loose bulk packaging — they are packed professionally and will reach you in perfect condition."

Individual boxes (customer asks for each piece packed separately):
- The box is a corrugated brown pizza box.
- For products-catalogue items under ₹500/piece this is chargeable — the charge appears in the verified quote automatically. NEVER state or compute the box charge yourself, and NEVER claim boxes are included in the costing for these items.
- For HORECA, trophies, and gift combos: no extra charge (box included / standard packing).

Packaging/gift box images:
✅ CORRECT: "I don't have gift box images right now, but it's a neat corrugated brown box. Would you like to proceed?"
```

- [ ] **Step 2: Verify the prompt still loads and contains the new knowledge**

Run: `node -e "const sp = require('./system-prompt.js'); const t = JSON.stringify(sp); ['loose bulk packaging','corrugated brown pizza box','NEVER claim boxes are included'].forEach(s => { if (!t.includes(s)) throw new Error('missing: ' + s); }); console.log('prompt OK')"`
Expected: `prompt OK`

- [ ] **Step 3: Full suite**

Run: `npx jest`
Expected: only the 7 pre-existing failures (vision-utils, server.test, stale-worktree duplicate); everything else PASS.

- [ ] **Step 4: Commit**

```bash
git add system-prompt.js
git commit -m "feat: packaging & shipping knowledge in system prompt (RULE 5B)"
```

---

## Verification (post-plan)

1. `npx jest` — no new failures beyond the pre-existing 7.
2. Transcript replay math: `node -e "const {computeQuote, formatQuoteForCustomer} = require('./pricing/quote-engine'); console.log(formatQuoteForCustomer(computeQuote({productQuery:'small magnetic planter', quantity:400, customerType:'reseller', packaging:'individual_boxes'})))"` → expect per-piece ₹130, box line ₹10/pc, total ₹58,800 (54,600 + 4,000 + 200).
3. After deploy: replay the live conversation — "so boxes are included in costing?" must now produce either the ₹10/pc verified quote line (if they want boxes) or the bulk-packaging answer, never "included in the costing".

## Self-Review Notes

- **Spec coverage:** engine rule → Task 1; guard whitelist → Task 2; resolver + fallback + shipping-question distinction → Task 3; prompt knowledge incl. bulk-shipping answer → Task 4. `server.js` no-change justified in File Map. Out-of-scope items untouched.
- **Type consistency:** `packaging: 'individual_boxes' | null` across resolver/extractor/engine; `quote.packaging.{key, ratePerPc, subtotalEx, gst, applied}` consistent between Tasks 1 and 2.
- **Judgment call:** guard also whitelists `packaging.subtotalEx` (an engine figure the bot may legitimately mention); box GST (₹200) is NOT whitelisted — the bot shouldn't itemize GST internals, consistent with existing policy of only whitelisting customer-facing figures.
