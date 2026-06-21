# RAG System — Operational Runbook

This document covers day-2 operations for the RAG (Retrieval-Augmented Generation) layer that makes the 9 Cork bot self-improving.

## Quick reference

| Endpoint | Purpose |
|---|---|
| `/health` | Overall server health |
| `/rag-stats` | RAG-specific metrics (conversation counts, conversion rate, recent failures) |

| Env var | Purpose | Default |
|---|---|---|
| `RAG_ENABLED` | Master switch for live retrieval + indexing | `false` |
| `RAG_RETRIEVAL_TIMEOUT_MS` | Max wait for Pinecone queries before fallback | `2000` |
| `PINECONE_API_KEY` | Pinecone authentication | (required) |
| `PINECONE_INDEX` | Pinecone index name | `ninecork-conversations` |
| `WEEKLY_REPORT_ENABLED` | Send Monday WhatsApp report | `false` |
| `ADMIN_WHATSAPP_NUMBER` | Where weekly report is sent (no `+`) | (required for reports) |
| `IMPORT_BUSINESS_NAME` | WhatsApp name to treat as "the bot" during import | `You` |

---

## First-time setup

1. **Create Pinecone account** at https://app.pinecone.io
   - Create index `ninecork-conversations`
   - Dimensions: `768`
   - Metric: `cosine`
   - Cloud: AWS, Region: `us-east-1`, Type: Serverless
   - Copy API key

2. **Set Render env vars:**
   - `PINECONE_API_KEY` = (from Pinecone)
   - `PINECONE_INDEX` = `ninecork-conversations`
   - `RAG_ENABLED` = `false` (start disabled)
   - `WEEKLY_REPORT_ENABLED` = `false`
   - `ADMIN_WHATSAPP_NUMBER` = (your business number)

3. **Import past chats** (see "Re-import past chats" below)

4. **Enable RAG:** flip `RAG_ENABLED` → `true` on Render, save (auto-redeploys)

5. **Verify:** send test WhatsApp message, check Render logs for `📚 RAG:` line

6. **Enable weekly report:** flip `WEEKLY_REPORT_ENABLED` → `true`

---

## Common operations

### Disable RAG (emergency rollback)

On Render: set `RAG_ENABLED=false` → save. Auto-redeploys in ~1 minute. Bot reverts to previous behavior.

### Re-import past chats

1. Drop `.txt` files in `data/past-chats/` (WhatsApp exports without media)
2. Dry-run preview:
   ```bash
   node scripts/import-chats.js --dry-run
   ```
3. Real import:
   ```bash
   node scripts/import-chats.js
   ```
4. Review borderline classifications:
   ```bash
   node scripts/review-uncertain.js
   ```

### Manually trigger weekly report

```bash
node scripts/weekly-cron.js
```

Reports save to `data/reports/weekly-YYYY-MM-DD.json` and ship via WhatsApp to admin.

### Apply weekly auto-fixes

```bash
node scripts/apply-suggestion.js --dry-run   # preview
node scripts/apply-suggestion.js             # apply, commit, push
```

### Check Pinecone vector count

Visit https://app.pinecone.io → `ninecork-conversations` → Records tab. Compare to MongoDB conversation count from `/rag-stats`.

### Run RAG tests

```bash
npm run test:rag    # RAG tests only
npm run test:all    # full test suite
```

---

## Troubleshooting

### Bot responses don't seem smarter

1. Check `/rag-stats` — is `embedded > 0`?
2. Tail Render logs while sending a test message — look for `📚 RAG:` line
3. Verify `RAG_ENABLED=true` in Render Environment tab
4. Verify `PINECONE_API_KEY` is set and matches dashboard

### Weekly report not arriving

1. Verify `WEEKLY_REPORT_ENABLED=true` on Render
2. Verify `ADMIN_WHATSAPP_NUMBER` is set correctly — country code, **no `+`**
3. Check Render logs around Monday 03:30 UTC for `🗓️ Running weekly analysis...`
4. Manually trigger via `node scripts/weekly-cron.js` to confirm WhatsApp delivery works

### Pinecone errors in logs

1. Check Pinecone dashboard → Usage tab for quota exhaustion
2. Verify `PINECONE_API_KEY` matches a non-rotated key in dashboard
3. Check index name spelling (`ninecork-conversations`)

### RAG latency spike

1. Lower `RAG_RETRIEVAL_TIMEOUT_MS` to `1000` for fail-fast behavior
2. Confirm Pinecone region is `us-east-1-aws` (lowest latency from Mumbai/India hosting)
3. Check Render server location

### Tests failing locally

1. Run `npm install` to ensure deps current
2. Set test env vars: `export GEMINI_API_KEY=test`, `export PINECONE_API_KEY=test`
3. Specific test: `npx jest tests/rag/embed.test.js --verbose`

### Async indexer failures

Check Render logs for `⚠️ Async indexing failed:` warnings. Common causes:
- Pinecone quota exceeded → upgrade plan
- Gemini embedding rate limit (1500/min) → check spike timing
- Network blip → transient, ignore

---

## Architecture quick reference

**Read path** (every message):
```
server.js webhook
  → retrieveContext()         [rag/retriever.js]
    → embed customer message  [rag/embed.js]
    → 3 parallel Pinecone queries (history, similar sales, products)
  → buildRagContext()         [rag/context-builder.js]
  → aiManager.getResponse()   [ai-provider-manager.js, augmented system prompt]
  → sendWhatsAppMessage()
```

**Write path** (after every response):
```
setImmediate(async fire-and-forget):
  → indexQAPair()             [rag/indexer.js]
    → embed Q&A pair          [rag/embed.js]
    → upsert to Pinecone      [rag/pinecone-client.js]
```

**Self-improvement** (Monday 9 AM IST):
```
cron.schedule('30 3 * * 1'):
  → runWeeklyAnalysis()       [scripts/weekly-cron.js]
    → re-tag in_progress with detectOutcome() [rag/outcome-detector.js]
    → batch send last 7 days to Groq
    → save report             [data/reports/weekly-YYYY-MM-DD.json]
    → WhatsApp summary to admin
```

---

## File map

| Path | Responsibility |
|---|---|
| `rag/pinecone-client.js` | Pinecone SDK singleton |
| `rag/embed.js` | Gemini text-embedding-004 wrapper |
| `rag/chat-parser.js` | WhatsApp `.txt` export parser |
| `rag/classifier.js` | Groq-based conversation outcome classifier |
| `rag/indexer.js` | Pinecone upsert with metadata |
| `rag/retriever.js` | Parallel Pinecone queries with smart filters |
| `rag/context-builder.js` | Token-budgeted prompt assembly |
| `rag/outcome-detector.js` | Rule-based outcome tagger (no AI) |
| `models/Conversation.js` | MongoDB schema (extended with RAG fields) |
| `models/RagFailure.js` | Failure log collection (auto-cleanup 30d) |
| `scripts/import-chats.js` | Bulk chat import orchestrator |
| `scripts/review-uncertain.js` | Terminal UI for borderline classifications |
| `scripts/weekly-cron.js` | Monday 9 AM IST analysis + report |
| `scripts/apply-suggestion.js` | Apply auto-approved prompt fixes |
