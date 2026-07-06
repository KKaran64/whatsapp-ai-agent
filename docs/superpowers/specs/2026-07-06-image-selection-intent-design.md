# Intent-Driven Image Selection — Design

**Date:** 2026-07-06
**Status:** Approved by user
**Trigger:** Live transcript — "share picture of magnetic planter" sent 8 assorted planter images. Root cause (systematic-debugging): the image path is an independent keyword stack — broad category regex (`image-routing.js:77`, "magnetic" discarded → mongoSearch `'PLANTER'`) plus a hardcoded size-only modifier filter (`server.js:970`, "magnetic" not a size → dropped). Fourth and last surviving keyword-matching stack; same disease fixed for pricing on 2026-07-05.

## Design

Image selection consumes the SAME understanding layer as pricing: `resolveIntent` already returns `productQuery` + `refinements` per turn.

### Flow (server.js image branch, ~957–1075)

1. Trigger + `resolveCategory` fire exactly as today (they also gate PDF catalogs and 'all').
2. NEW: when the resolved category `hasImages`, call `resolveIntent(userMessage, conversationContext, { budgetMs: 3000 })`.
3. Search term selection (pure function, unit-tested):
   - `intent.productQuery` present → term = `productQuery`; refinements = `intent.refinements`
   - otherwise → term = category's `mongoSearch` (today's behavior — this is the regex-outage/no-intent fallback), refinements = `[]`
4. `findProductsByCategory(term, ...)` as today (its universal name/tags/aliases search already handles phrases). If a productQuery term returns ZERO products, retry once with the category's `mongoSearch` term (broad fallback), keeping the refinements.
5. NEW: narrow results by refinements before sending (see refinement-filter below).
6. DELETE the v53.15 hardcoded size filter (`sizePattern` block + its conversation-context scan): sizes ("small", "a5") arrive as refinements now.
7. PDF-catalog categories, 'all' variety path, combos path, sent-images tracker: unchanged.

### `pricing/refinement-filter.js` (new, one responsibility)

`filterByRefinements(items, refinements, getName = i => i.name)`:
- Same semantics as the quote engine's narrowing: positive refinements NARROW to matching items when ≥1 item matches (zero matches → refinement ignored); `'!'`-prefixed refinements always exclude; empty refinements → items unchanged.
- Matching rule per token: **exact match always counts** (so short refinements like `a5` work); additionally **prefix-tolerant** when both tokens are ≥4 chars (either is a prefix of the other), so `magnetic` matches both `magnetic` and `magnet` but `big` never prefix-matches `bigger-junk` tokens. Required because catalog/Mongo names use both forms (SMALL MAGNETIC PLANTER, FRIDGE MAGNET PLANTER).
- Quote engine is NOT modified (its stemmer + boost behavior stays byte-identical; changing engine matching is out of scope).

### Pinned acceptance case (the live transcript)

"Pls share picture of magnetic planter" → intent `{productQuery: 'planter'|'magnetic planter', refinements: ['magnetic']}` → planter results narrowed to MAGNET/MAGNETIC names only → customer receives magnetic planter image(s), not 8 assorted planters.

### Failure modes (all degrade to today's behavior)

- Resolver LLM down → regex fallback intent (or null) → category term, no narrowing → today's broad batch.
- Refinement matches nothing in results → refinement ignored → today's broad batch.
- Both are strictly-no-worse degradations; the guard rails (sent-tracker, limits) unchanged.

## Testing

- Unit: `refinement-filter` — narrow, ignore-when-no-hit, negative exclude, prefix tolerance (magnetic↔magnet), empty refinements identity.
- Unit: search-term selection function — productQuery present/absent, refinement passthrough.
- Pinned regression: planter-name list from the live transcript + `['magnetic']` → only magnet names survive.
- Engine regression: full suite — quote-engine behavior byte-identical (it is not touched).

## Out of Scope

- Changing `image-routing.js` category definitions or PDF routing
- Quote-engine matching changes
- MongoDB Product schema/tag changes
