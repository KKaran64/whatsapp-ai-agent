# Individual-Box Packaging Rule — Design

**Date:** 2026-07-06
**Status:** Approved by user
**Trigger:** Live transcript — bot claimed "boxes are included in the costing" for a ₹130 catalogue planter. False: individual boxes are chargeable. The LLM had no packaging knowledge and invented policy.

## The Rule (user-defined)

- Individual boxes cost **₹10 per piece + 5% GST** (₹10 is GST-exclusive).
- Applies **only** to `catalogue`-section products whose **quoted per-piece price (post-discount) is under ₹500**.
- Charged **only when the customer requests** individual boxes; standard bulk packing is the default and free.
- **Not applicable** (no charge, box included / standard packing): HORECA, trophies, gift combos, wall panels, and catalogue items at ≥₹500/pc.
  - Combos and wall panels are not in the engine's quotable data at all (combos section exists in `data/pricing.json` but is not loaded by `findProducts`; wall panels absent) — excluded structurally.
- Box description for customer conversation: **corrugated brown pizza box**.

## Design

Same architecture as the branding fee: the deterministic engine computes the charge; the LLM only requests and presents it. The intent resolver captures the customer's packaging request; the numeric guard whitelists the box figures.

### 1. `pricing/quote-engine.js`

- `computeQuote({ productQuery, quantity, customerType, branding, refinements, packaging })` — new optional `packaging: 'individual_boxes' | null | undefined`.
- Eligibility: `packaging === 'individual_boxes'` AND `top.source === 'catalogue'` AND `perPiece < 500`.
- When eligible: `packagingSubtotalEx = 10 × quantity`, `packagingGst = round(subtotal × 0.05)`, both added into `subtotalEx` / `totalGst` / `grandTotal`. Quote gains:
  ```js
  packaging: { key: 'individual_boxes', ratePerPc: 10, subtotalEx, gst, applied: true }
  ```
- Requested but not eligible: `packaging: { key: 'individual_boxes', applied: false }` and **no charge added** (customer-facing meaning: included / standard packing, no extra cost).
- Not requested: `packaging: null` (field present for shape stability).
- `formatQuoteForCustomer`: when `packaging.applied`, add sentence `Individual boxes: ₹10 per piece.` before the total.
- No packaging argument → behavior byte-identical to today (regression guard).

### 2. `pricing/intent-resolver.js`

- Intent contract gains `packaging: 'individual_boxes' | null`.
- LLM prompt: new field + rule line ("only set when the customer asks for individual/separate/gift boxes per piece") + one worked example.
- Validation: enum check, else null.
- Regex fallback (`intent-extractor.js`): `detectPackaging(texts)` with pattern `/\b(individual|separate|each in a|per piece)\s+(box|boxes|packing|packaging)\b|\bbox packing\b/i` so outages still catch explicit requests.

### 3. `pricing/state-enforcer.js`

- `allowedQuoteAmounts` additionally includes `quote.packaging.ratePerPc` when applied, so the outbound numeric guard permits ₹10.

### 4. `system-prompt.js`

Short PACKAGING knowledge block:
- Default: standard bulk packing, free.
- Individual boxes = corrugated brown pizza boxes; chargeable for catalogue products under ₹500/pc (the engine adds ₹10/pc to the verified quote — never state the charge yourself).
- HORECA / trophies / gift combos: box included or standard packing — no extra charge.
- NEVER claim boxes are included in the costing for under-₹500 catalogue products.

## Testing

- Engine: eligible case (catalogue, <₹500, requested → totals include 10×qty + 5% GST); ≥₹500 catalogue → applied:false, no charge; horeca/trophies product → applied:false; not requested → packaging null and totals identical to pre-change (regression); GST math exact.
- Live-transcript case: SMALL MAGNETIC PLANTER ₹130 × 400 + individual boxes → box line ₹4,000 + ₹200 GST on top of the product quote.
- Resolver: extracts `packaging: 'individual_boxes'` from "can you pack each one separately?"; validation nulls unknown values; regex fallback catches "individual boxes".
- Enforcer: reply containing ₹10 with applied packaging → allowed; fabricated box rate (e.g. ₹15) → blocked.
- Format: applied → sentence present; not applied → absent.

## Out of Scope

- Quoting gift combos (combos section still not loaded by the engine — separate feature if wanted).
- Wall panels (absent from engine data).
- Any other packaging types.
