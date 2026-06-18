# RAG-Based Self-Improving Sales Bot — Design Spec

**Project:** 9 Cork WhatsApp Sales Bot — Self-Training Architecture
**Date:** 2026-06-19
**Status:** Approved for implementation

---

## 1. Objective

Transform the existing 9 Cork WhatsApp bot from a static rule-based assistant into a self-improving sales agent that:

- Learns from 300+ past customer conversations
- Retrieves relevant past examples in real-time before responding
- Automatically indexes new conversations as they happen
- Identifies its own failures via weekly AI analysis
- Reports insights and prompt fixes via WhatsApp every Monday
- Maximizes token usage from 73% → 99% per request

The bot should reach 70% match with human sales quality at launch, climbing to 85-90% within 3 months without manual prompt engineering.

---

## 2. Architecture Overview

Six components, all living in the existing `whatsapp-claude-bridge` repo:

```
┌─────────────────────────────────────────────────────────┐
│  EXISTING                       │  NEW (RAG ADDITION)    │
├─────────────────────────────────┼────────────────────────┤
│  server.js (webhook)            │  rag/embed.js          │
│  ai-provider-manager.js         │  rag/retriever.js      │
│  vision-handler.js              │  rag/indexer.js        │
│  MongoDB (conversations)        │  Pinecone (vectors)    │
│                                 │  scripts/import-chats.js│
│                                 │  scripts/weekly-cron.js│
└─────────────────────────────────┴────────────────────────┘
```

### Tech stack

| Component | Choice | Why |
|---|---|---|
| Vector store | Pinecone (free tier) | 100k vectors, managed, low-maintenance |
| Embeddings | Gemini `text-embedding-004` | Free, 768-dim, 1500 req/min |
| Generation | Groq `llama-3.3-70b-versatile` (existing) | Already configured, free |
| Storage | MongoDB Atlas (existing) | Already running |
| Scheduler | `node-cron` on Render | Free, no new infra |
| Deploy | Render (existing) | Auto-deploys on git push |

---

## 3. Data Model

### MongoDB schema additions

Append to `models/Conversation.js`:

```javascript
{
  // ... existing fields preserved ...

  // RAG metadata
  outcome: {
    type: String,
    enum: ['in_progress', 'sale', 'no_sale', 'abandoned'],
    default: 'in_progress',
    index: true
  },
  outcomeAmount: { type: Number, default: 0 },
  outcomeDetectedAt: Date,
  embedded: { type: Boolean, default: false, index: true },
  embeddingIds: [String],
  embeddingError: String
}
```

New collection `rag_failures` for debugging:

```javascript
{
  customerPhone: String,
  customerMessage: String,
  failureType: String,
  context: Object,
  timestamp: Date
}
```

### Pinecone schema

Index name: `ninecork-conversations`
Dimensions: 768 (Gemini text-embedding-004)
Metric: cosine similarity

Vector record:

```javascript
{
  id: "{customerPhone}_msg_{messageIndex}",
  values: [768 floats],
  metadata: {
    customerPhone: String,
    customerMessage: String,
    botResponse: String,
    products: [String],
    quantity: Number,
    budget: Number,
    outcome: String,
    saleAmount: Number,
    timestamp: Number,
    isStaleForPricing: Boolean,
    productStillAvailable: Boolean,
    conversationStage: String  // greeting/qualification/pricing/closing
  }
}
```

**Granularity:** One vector per Q&A pair (not per full conversation).

---

## 4. Cost Projections

| Scale | Vectors | Monthly Cost |
|---|---|---|
| Year 1 (300 imported + 50/week) | ~3,000 | ₹0 |
| Year 2 (~5,000 conversations) | ~50,000 | ₹0 |
| Year 3 (~15,000 conversations) | ~150,000 | ~₹5,800 ($70) |
| Year 5 (~50,000 conversations) | ~500,000 | ~₹5,800 ($70) |

Pinecone free tier: 100k vectors, 1 index. Gemini embeddings: always free at expected volume.

---

## 5. Import Pipeline (One-Time)

Script: `scripts/import-chats.js`

### Input
Folder: `/data/past-chats/` containing WhatsApp `.txt` exports.

### Processing steps

1. Parse WhatsApp format → extract messages with timestamps
2. Identify customer vs business (`9 Cork Sustainable Products`)
3. Group messages into Q&A pairs
4. For each conversation, use Groq to classify:
   - Outcome (sale/no_sale/abandoned/in_progress)
   - Sale amount in INR (if detected)
   - Products discussed
   - Customer type (corporate/HORECA/retail)
   - Budget mentioned
5. For each Q&A pair:
   - Generate Gemini embedding
   - Store in Pinecone with metadata
6. Store full conversation in MongoDB
7. Log progress in terminal

### Safety filters

| Rule | Reason |
|---|---|
| Skip <5 messages | Too short for value |
| Skip if no clear customer question | Not a sales chat |
| Tag >12 months old as "outdated" | Stale prices |
| Skip personal chats (detected via keywords) | Won't pollute KB |
| Auto-detect sale via payment keywords | Outcome tagging |

### Recommended 2-batch approach

1. First batch: 50 chats → verify quality
2. Second batch: 250 chats → bulk import after validation

### Manual review step

After import, `scripts/review-uncertain.js` provides terminal UI for approving/rejecting borderline classifications (~15 mins).

---

## 6. Live RAG Flow

Per-message lifecycle:

| Step | Component | Latency |
|---|---|---|
| 1. Webhook receives | server.js | 50ms |
| 2. Embed customer message | rag/embed.js (Gemini) | 150ms |
| 3. 3 parallel Pinecone queries | rag/retriever.js | 300ms |
| 4. Assemble context | rag/retriever.js | 50ms |
| 5. Groq generation | ai-provider-manager.js | 800ms |
| 6. Send to WhatsApp | server.js | 200ms |
| 7. Async background indexing | rag/indexer.js | (non-blocking) |

**Total user-perceived latency:** ~1.7s (vs ~1.0s currently). Acceptable for sales conversations.

### Three parallel Pinecone queries

```javascript
Promise.all([
  retrieveCustomerHistory(customerPhone, embedding),       // 3-5 results
  retrieveSimilarConversations(embedding, {outcome: 'sale'}), // 5 results
  retrieveProductContext(embedding, {productMentioned})    // 3 results
])
```

### Retrieval filters

Pricing queries:
```javascript
filters: {
  outcome: { $in: ['sale', 'in_progress'] },
  isStaleForPricing: false,
  productStillAvailable: true,
  budget: { $gte: customerBudget * 0.5, $lte: customerBudget * 2 }
}
```

Discount/objection queries:
```javascript
filters: {
  outcome: 'sale',                  // only learn from won deals
  conversationStage: 'closing'      // specifically objection handling
}
```

### Token budget allocation

| Component | Tokens | % of 32k |
|---|---|---|
| Compressed system prompt | 12,000 | 38% |
| Last 50 messages context | 5,000 | 16% |
| Customer's past purchases | 3,000 | 9% |
| 5 similar successful sales | 8,000 | 25% |
| Product knowledge injection | 3,500 | 11% |
| Current message | 200 | 1% |
| **Total** | **31,700** | **99%** |

### Graceful degradation

| Failure | Fallback |
|---|---|
| Pinecone unreachable | Skip retrieval, use system prompt only |
| Gemini embedding fails | Use cached embeddings, else skip |
| No similar conversations found | Use system prompt only |
| Retrieval timeout (>2s) | Cancel retrieval, send response |

RAG enhances but never blocks. Customer always gets a reply.

### Performance optimizations

1. Cache hot queries (greetings) — skip retrieval
2. Parallel Pinecone calls — 3 simultaneous queries
3. Async indexing — happens AFTER response sent
4. Lazy embedding — skip "ok", "thanks", "yes"

---

## 7. Self-Improvement Loops

### Loop 1 — Real-time learning (per-message)

Every customer↔bot exchange is embedded and stored in Pinecone immediately after response delivery (async). The bot is measurably smarter at message N+1 than message N.

### Loop 2 — Outcome detection (event-driven)

Auto-tags conversations:

| Signal | Outcome | Confidence |
|---|---|---|
| "paid"/"transferred"/"payment done" + amount | sale | High |
| Bot sent payment details + positive response + 24hr silence | likely_sale | Medium |
| Customer ghosts >7 days after 5+ questions | abandoned | High |
| "too expensive"/"let me think" + no return | no_sale | High |
| Active back-and-forth | in_progress | High |

Outcome updates trigger Pinecone metadata refresh, biasing future retrievals toward successful patterns.

### Loop 3 — Weekly analysis cron

Runs every Monday 9 AM IST via `node-cron` on Render.

Script: `scripts/weekly-cron.js`

Process:
1. Pull last 7 days of conversations from MongoDB
2. Batch send to Groq with analysis prompt
3. Generate structured report
4. Send WhatsApp message to admin business number
5. If `auto_apply: true` patterns found, queue for review

### Weekly report format

Delivered via WhatsApp to admin number:

```
📊 9 CORK BOT — WEEKLY REPORT (week 23)

CONVERSATIONS: 87 (↑12%)
SALES: 23 (₹2,14,500)
CONVERSION: 26.4% (↑3.2%)

🟢 TOP WINS: [details]
🔴 TOP ISSUES: [details]
📈 LEARNED: [details]
🔧 RECOMMENDED ACTIONS:
  [1] Auto-apply minor fixes — reply "yes 1"
  [2] Review major changes — reply "review"
```

### Auto-apply vs review classification

| Change type | Auto-apply? | Examples |
|---|---|---|
| Add example to system prompt | Yes | New edge case handling |
| Update product catalog text | Yes | Fix typo, add new product |
| Add GST/pricing clarification | Yes | Missing tax info |
| Modify sales methodology | No | Changing SPIN/DPS approach |
| Change pricing tier structure | No | TIER 1 → TIER 2 thresholds |
| Update brand persona | No | Changing voice/tone |

### Safety guardrails

System **cannot**:
- Modify pricing tier thresholds without approval
- Remove existing rules (only adds new ones)
- Change brand persona or voice
- Share customer data externally

System **can**:
- Add new examples to system prompt
- Update product catalog references
- Tag conversations with outcomes
- Adjust retrieval filters
- Send weekly insights

---

## 8. New File Structure

```
whatsapp-claude-bridge/
├── server.js                  (modified: hook RAG into webhook)
├── ai-provider-manager.js     (modified: accept retrieved context)
├── rag/                       (NEW)
│   ├── embed.js               (Gemini embedding wrapper)
│   ├── retriever.js           (Pinecone query + context assembly)
│   ├── indexer.js             (async store new conversations)
│   ├── outcome-detector.js    (auto-tag conversation outcomes)
│   └── pinecone-client.js     (Pinecone SDK wrapper)
├── scripts/
│   ├── import-chats.js        (NEW: bulk import past chats)
│   ├── review-uncertain.js    (NEW: terminal UI for review)
│   ├── weekly-cron.js         (NEW: Monday 9 AM analysis)
│   └── apply-suggestion.js    (NEW: apply auto-fixes to prompt)
├── data/
│   └── past-chats/            (NEW: drop WhatsApp .txt exports here)
└── models/
    └── Conversation.js        (modified: add RAG fields)
```

---

## 9. New Environment Variables

Add to Render `.env`:

```
PINECONE_API_KEY=<from pinecone dashboard>
PINECONE_ENVIRONMENT=us-east-1-aws
PINECONE_INDEX=ninecork-conversations
GEMINI_EMBEDDING_KEY=<reuse existing GEMINI_API_KEY>
ADMIN_WHATSAPP_NUMBER=<your business number for weekly reports>
WEEKLY_REPORT_ENABLED=true
RAG_ENABLED=true   # feature flag to disable RAG without breaking bot
RAG_RETRIEVAL_TIMEOUT_MS=2000
```

---

## 10. Phased Rollout Plan

### Phase 1 — Foundation (Week 1)
- Set up Pinecone account + index
- Build `rag/embed.js`, `rag/pinecone-client.js`
- Add MongoDB schema fields
- Build import script with 50 test chats

### Phase 2 — Import (Week 1-2)
- Run first batch (50 chats)
- Manual review uncertain classifications
- Validate Pinecone metadata quality
- Bulk import remaining 250 chats

### Phase 3 — Live RAG (Week 2-3)
- Build `rag/retriever.js` + `rag/indexer.js`
- Hook into `ai-provider-manager.js`
- Deploy with `RAG_ENABLED=false` initially
- Enable for 10% of conversations (A/B test)
- Compare quality vs baseline
- Roll out to 100%

### Phase 4 — Self-Improvement (Week 3-4)
- Build `scripts/weekly-cron.js`
- Build outcome detection
- Build auto-apply mechanism
- Run first weekly report
- Iterate based on report quality

### Phase 5 — Production (Week 4+)
- Monitor conversion metrics
- Tune retrieval filters based on real data
- Add Pinecone Charts dashboard
- Document operational runbook

---

## 11. Success Metrics

| Metric | Baseline | Month 1 Target | Month 3 Target |
|---|---|---|---|
| Token utilization | 73% | 95% | 99% |
| Conversion rate (msg → sale) | ~15% (estimated) | 22% | 28% |
| Hallucination incidents/week | ~12 | 4 | 1 |
| Avg response latency | 1.0s | 1.7s | 1.5s |
| Customer "yes-loop" failures/week | ~5 | 0 | 0 |
| Bot quality vs human (eval) | 50% | 70% | 85% |

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Pinecone goes down | Graceful degradation to system-prompt-only mode |
| Outdated prices in retrieved examples | 90-day staleness filter + product validity check |
| Bot learns from failed sales | Outcome filtering on all retrieval queries |
| Gemini embedding rate limits | Cache embeddings, batch processing |
| Cost overrun at scale | Switch to pgvector self-hosted if Pinecone bill >₹10k/mo |
| Bad classifications during import | 2-batch approach + manual review checkpoint |

---

## 13. Open Decisions (Resolve During Implementation)

1. Exact prompt for outcome classification AI — needs iteration
2. Cache TTL for greeting/common-query responses — start at 5min
3. How many retrievals per query (currently 5+3+3=11) — A/B test
4. System prompt compression strategy — manual review needed
5. Weekly report time zone confirmation — assumed IST

---

## 14. Out of Scope (Future Phases)

- Fine-tuning a custom model (requires 1000+ conversations + budget)
- Voice message handling (vision handler exists; voice is separate)
- Multi-language support (currently English/Hinglish)
- Real-time sentiment analysis dashboard
- Customer CRM integration
- Corke brand spinoff (separate spec)

---

**Approved by:** User
**Implementation owner:** Claude Code
**Next step:** Invoke `superpowers:writing-plans` skill to create implementation plan.
