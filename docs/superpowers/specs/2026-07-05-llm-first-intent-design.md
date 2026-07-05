# LLM-First Intent Extraction — Design

**Date:** 2026-07-05
**Status:** Approved by user (brainstorming session)
**Replaces:** regex-primary intent extraction + two LLM rescue layers (v61.1 classifier, v61.2 disambiguator)

## Problem

The pricing pipeline extracts what the customer wants (product, quantity, customer type) using **regex pattern-matching** (`pricing/intent-extractor.js`). Regex cannot understand conversational sentences, so it misses refinements like *"for office work desktop mats are better"*. Observed live bug:

> Customer: "I need 200 mats for office"
> Bot: lists Coffee Mat, Desktop Mat, Yoga Mat
> Customer: "for office work desktop mats are better, right?"
> Bot: agrees — but the refinement is never captured
> Customer: "what are the other options?"
> Bot: lists all three mats again (refinement lost — loop)

Two patches were bolted downstream to rescue specific failures:

- `pricing/llm-classifier.js` (v61.1) — rescues customer-type when regex misses it
- `pricing/llm-disambiguator.js` (v61.2) — rescues product ambiguity after the engine returns `multiple_matches`

**Root cause:** regex is the wrong primary tool for conversational understanding. Each rescue layer patches a downstream symptom of the same gap, duplicates Groq plumbing (`collectGroqKeys`, `callGroq`, failover), and can stack two sequential LLM round-trips in a single turn.

## Decision Summary (user-confirmed)

| Decision | Choice |
|---|---|
| Scope | Full LLM-first extraction (Approach 1: LLM understands, engine selects) |
| When the LLM runs | Every inbound customer message |
| On LLM outage | Fall back to regex extractor + telemetry flag on every degraded turn |
| Pricing authority | `quote-engine.js` stays deterministic and untouched in its math |

## Design

**One AI call reads the conversation and fills a simple form. The existing deterministic price engine does everything else.**

The LLM never sees the catalog, never names a SKU, never touches a price. Worst case for a bad extraction is a wrong-but-real catalog lookup or `not_found` — never a wrong price.

### The intent contract

`resolveIntent(conversation, {budgetMs})` returns:

```js
{
  productQuery: 'mat' | null,          // customer's noun phrase, NOT a SKU
  refinements: ['desktop', 'office'],  // narrowing terms; negatives prefixed '!': '!yoga'
  quantity: 200 | null,
  customerType: 'end_consumer' | 'reseller' | null,
  branding: 'laser' | 'multi-color' | 'pad-printing' | 'single-color' | null,
  confidence: 0.0-1.0,
  source: 'llm' | 'regex_fallback',
  reasoning: 'one sentence'            // logs only, never shown to customer
}
```

### Per-turn data flow

```
inbound msg → sanitize → resolveIntent(conversation)     ← ONE Groq call
                             │ success           │ failure (budget spent / keys down / bad output)
                             ▼                   ▼
                       structured intent   regex extractIntent()
                       source:'llm'        source:'regex_fallback' + telemetry flag
                             └────────┬──────────┘
                                      ▼
                        computeQuote(intent)   ← deterministic, refinement-aware
                             │ found           │ multiple_matches      │ not_found / missing
                             ▼                 ▼                       ▼
                       [VERIFIED QUOTE]  [PRODUCT AMBIGUOUS]     [NO MATCH / ask]
```

### Why the refinement-loss bug goes away

Refinements are **re-derived from the conversation window (last ~10 messages) every turn**, not incrementally patched. When the customer asks "what are the other options?", the earlier message "desktop mats are better for office" is still in the window, so "desktop" stays in the refinements box. The conversation is the state — no new persistence layer, and one bad extraction cannot poison the next turn.

## Components

### New

- **`pricing/groq-client.js`** — shared Groq plumbing, extracted from the duplicated code in classifier + disambiguator: `collectGroqKeys()`, `callGroq(messages, {timeoutMs})`, multi-key failover, wall-clock budget loop (lifted from v61.2: total budget ~3s, remaining budget becomes each attempt's axios timeout, keys skipped once budget is spent). Single source of truth for `GROQ_URL` and `MODEL`.
- **`pricing/intent-resolver.js`** — the LLM-first extractor. Makes the single Groq call, validates the output schema strictly, falls back to regex on any failure.

### Modified

- **`pricing/intent-extractor.js`** — kept as the **fallback only**. Same regex logic; called by the resolver, no longer by `server.js` directly.
- **`pricing/quote-engine.js`** — `findProducts(query, refinements)` and `computeQuote({..., refinements})` become refinement-aware: positive refinements boost match scores, negative refinements (`'!yoga'`) exclude candidates. The existing ambiguity rule (`top.score − second.score < 20 && top.score < 100` → `multiple_matches`) stays; refinement signal makes ties rare instead of routine. Pricing math untouched.
- **`pricing/conversation-state.js`** — remove the `require('./llm-classifier')` branch in `deriveStateAsync` (it already short-circuits when `intent.customerType` is present at line ~351, so this is dead code once the resolver supplies customer type).
- **`server.js`** — call `resolveIntent` once per turn in `processWithClaudeAgent`; delete the v61.2 `multiple_matches` → disambiguator block; keep the `[VERIFIED QUOTE]` / `[PRODUCT AMBIGUOUS]` / `[NO CATALOG MATCH]` injection blocks as-is.

### Retired (deleted)

- `pricing/llm-disambiguator.js` + its server.js wiring + `tests/llm-disambiguator.test.js` (budget-loop tests migrate to `groq-client` tests)
- `pricing/llm-classifier.js` + its per-phone classification cache

### Unchanged

- `pricing/quote-engine.js` pricing math, `pricing/state-enforcer.js` (stays as the final post-LLM backstop), `[VERIFIED QUOTE]` prompt-injection pattern, webhook paths.

## Error Handling

Ordered by likelihood:

1. **Groq slow / rate-limited:** wall-clock budget (~3s total across key attempts). Budget spent → regex fallback same turn; customer never sees a failure.
2. **All keys down (outage):** regex fallback per turn + structured log line (`intent-resolver: regex_fallback — <reason>`) + counter on the existing v61 stats/telemetry path, so degraded-turn frequency is visible.
3. **Malformed LLM output:** strict schema validation. Safe coercions applied (numeric string → number); an invalid field is nulled individually; a fully invalid response counts as a key failure → next key or fallback.
4. **Hallucination containment (by construction):** the LLM cannot name a SKU or price because it never sees the catalog. `state-enforcer.js` remains as the independent final guard.
5. **Low confidence (< 0.6):** do not attempt a quote; ask the customer a clarifying question. The extraction still updates conversation state so the next turn benefits.

**Deliberate non-goal:** no intent caching between turns. Re-derivation each turn is self-healing; the classifier's per-phone cache dies with the module.

## Testing

1. **Unit — `groq-client.js`:** key collection, failover order, budget-spent skip, per-attempt timeout = remaining budget (migrated from the existing 17-test disambiguator suite pattern: mocked axios, env-controlled keys).
2. **Unit — `intent-resolver.js`:** happy-path extraction (mocked Groq JSON), schema validation (bad types nulled per-field), full-failure → regex fallback with `source: 'regex_fallback'`, low-confidence passthrough.
3. **Unit — `quote-engine.js`:** refinement-aware selection — "mat" + `['desktop']` → single Desktop Mat match; "mat" + `['!yoga']` excludes yoga mats; no refinements → existing behavior byte-identical (regression guard).
4. **Replay:** run existing conversation scenarios (`test-scenarios.md`, `run-test-batch.js`) through the new path; compare outcomes against current behavior before deploy. The office-mats refinement-loss conversation becomes a permanent regression scenario.

## Rollout

- Env kill-switch: `INTENT_RESOLVER=llm` (default) | `regex`. Set to `regex` on Render to revert to today's behavior instantly without a code redeploy.
- Deploy sequence: ship with kill-switch available → watch the `regex_fallback` counter and quote-related logs → delete the retired modules in a follow-up commit once stable (deletion is the last step, not the first).
- Free-tier quota note: one Groq call per inbound message replaces up to two rescue calls per uncertain turn today. Volume is bounded by WhatsApp message rate; `llama-3.3-70b-versatile` on free tier covers current traffic. If quota pressure appears, the kill-switch degrades gracefully.

## Out of Scope

- Any change to pricing math, GST, slab discounts, or branding rules
- The RAG pipeline, vision/image routing, audio handling
- The 10-issue security/reliability overhaul plan (`docs/superpowers/plans/2026-04-07-overhaul.md`) — separate effort
