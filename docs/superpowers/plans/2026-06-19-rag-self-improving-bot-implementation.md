# RAG Self-Improving Sales Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the existing 9 Cork WhatsApp bot into a RAG-powered self-improving sales agent that learns from 300+ past conversations, retrieves relevant examples per message, and self-improves via weekly AI analysis.

**Architecture:** Add a new `rag/` directory of modules alongside existing code. Pinecone (free tier) stores conversation embeddings; Gemini provides free embeddings; existing Groq/MongoDB stack handles generation/persistence. RAG enhances responses but degrades gracefully — bot always replies even if Pinecone/embedding fails.

**Tech Stack:** Node.js (CommonJS), Pinecone, Gemini `text-embedding-004`, Groq llama-3.3-70b, MongoDB Atlas, Render, Jest for tests, `node-cron` for scheduling.

---

## File Structure

```
whatsapp-claude-bridge/
├── rag/                          NEW
│   ├── pinecone-client.js        Pinecone SDK singleton wrapper
│   ├── embed.js                  Gemini embedding wrapper
│   ├── chat-parser.js            WhatsApp .txt format parser
│   ├── classifier.js             Groq-based conversation classifier
│   ├── indexer.js                Async write to Pinecone
│   ├── retriever.js              Parallel Pinecone queries
│   ├── context-builder.js        Assembles retrieved data into prompt context
│   └── outcome-detector.js       Auto-tag conversation outcomes
├── scripts/
│   ├── import-chats.js           NEW: Bulk import past chats
│   ├── review-uncertain.js       NEW: Terminal UI for review
│   ├── weekly-cron.js            NEW: Monday 9 AM analysis
│   └── apply-suggestion.js       NEW: Apply auto-fixes to prompt
├── models/
│   ├── Conversation.js           MODIFY: Add RAG fields
│   └── RagFailure.js             NEW: Debug log collection
├── data/
│   └── past-chats/               NEW: Drop .txt files here
├── tests/
│   └── rag/                      NEW: Unit tests for all rag/ modules
├── server.js                     MODIFY: Hook RAG into webhook
└── ai-provider-manager.js        MODIFY: Accept retrieved context
```

---

## Pre-requisites (Manual — do these first)

### A. Create Pinecone account

- [ ] Sign up at https://app.pinecone.io (free tier)
- [ ] Create new index named `ninecork-conversations`
  - Dimensions: `768`
  - Metric: `cosine`
  - Cloud: AWS, Region: us-east-1
  - Type: Serverless
- [ ] Copy API key from "API Keys" section
- [ ] Save credentials to share with implementer

### B. Verify Gemini access for embeddings

- [ ] Confirm `GEMINI_API_KEY` in `.env` has embedding access
- [ ] Test with: `curl "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=$GEMINI_API_KEY" -H 'Content-Type: application/json' -d '{"content":{"parts":[{"text":"test"}]}}'`
- [ ] Expected: JSON with `embedding.values` array of 768 floats

### C. Export 50 test conversations from WhatsApp

- [ ] Pick 50 representative customer chats
- [ ] Export each: chat → 3-dots → More → Export Chat → Without Media
- [ ] Save to `/Users/kkaran/whatsapp-claude-bridge/data/past-chats/`

---

## PHASE 1 — Foundation (Tasks 1-6)

### Task 1: Install RAG dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Pinecone SDK and node-cron**

```bash
cd /Users/kkaran/whatsapp-claude-bridge
npm install @pinecone-database/pinecone@^4.0.0 node-cron@^3.0.3
```

- [ ] **Step 2: Verify installation**

Run: `node -e "console.log(require('@pinecone-database/pinecone').Pinecone.name)"`
Expected: `Pinecone`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(rag): add Pinecone and node-cron dependencies"
```

---

### Task 2: Build Pinecone client wrapper

**Files:**
- Create: `rag/pinecone-client.js`
- Create: `tests/rag/pinecone-client.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/rag/pinecone-client.test.js`:

```javascript
const { getIndex, isConfigured } = require('../../rag/pinecone-client');

describe('pinecone-client', () => {
  test('isConfigured returns false when PINECONE_API_KEY missing', () => {
    const original = process.env.PINECONE_API_KEY;
    delete process.env.PINECONE_API_KEY;
    expect(isConfigured()).toBe(false);
    process.env.PINECONE_API_KEY = original;
  });

  test('isConfigured returns true when PINECONE_API_KEY set', () => {
    process.env.PINECONE_API_KEY = 'test-key';
    process.env.PINECONE_INDEX = 'test-index';
    expect(isConfigured()).toBe(true);
  });

  test('getIndex throws if PINECONE_API_KEY missing', () => {
    const original = process.env.PINECONE_API_KEY;
    delete process.env.PINECONE_API_KEY;
    expect(() => getIndex()).toThrow('PINECONE_API_KEY not set');
    process.env.PINECONE_API_KEY = original;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/pinecone-client.test.js`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write the implementation**

Create `rag/pinecone-client.js`:

```javascript
// Pinecone SDK singleton wrapper.
// Lazy-initializes the client only when first accessed so import is cheap.

const { Pinecone } = require('@pinecone-database/pinecone');

let client = null;
let index = null;

function isConfigured() {
  return !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);
}

function getClient() {
  if (!process.env.PINECONE_API_KEY) {
    throw new Error('PINECONE_API_KEY not set');
  }
  if (!client) {
    client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return client;
}

function getIndex() {
  if (!index) {
    const c = getClient();
    const indexName = process.env.PINECONE_INDEX || 'ninecork-conversations';
    index = c.index(indexName);
  }
  return index;
}

module.exports = { getClient, getIndex, isConfigured };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/rag/pinecone-client.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/pinecone-client.js tests/rag/pinecone-client.test.js
git commit -m "feat(rag): add Pinecone client wrapper"
```

---

### Task 3: Build Gemini embedding wrapper

**Files:**
- Create: `rag/embed.js`
- Create: `tests/rag/embed.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/rag/embed.test.js`:

```javascript
const embed = require('../../rag/embed');

jest.mock('axios');
const axios = require('axios');

describe('embed', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    axios.post.mockReset();
  });

  test('embedText returns 768-dim vector on success', async () => {
    const fakeVector = new Array(768).fill(0.1);
    axios.post.mockResolvedValue({ data: { embedding: { values: fakeVector } } });
    const result = await embed.embedText('hello cork coasters');
    expect(result).toHaveLength(768);
    expect(result[0]).toBe(0.1);
  });

  test('embedText returns null on API error', async () => {
    axios.post.mockRejectedValue(new Error('API down'));
    const result = await embed.embedText('hello');
    expect(result).toBeNull();
  });

  test('embedText returns null on empty input', async () => {
    const result = await embed.embedText('');
    expect(result).toBeNull();
  });

  test('embedBatch processes array sequentially', async () => {
    const fakeVector = new Array(768).fill(0.5);
    axios.post.mockResolvedValue({ data: { embedding: { values: fakeVector } } });
    const result = await embed.embedBatch(['a', 'b', 'c']);
    expect(result).toHaveLength(3);
    expect(axios.post).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/embed.test.js`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write the implementation**

Create `rag/embed.js`:

```javascript
// Gemini embedding wrapper. Uses text-embedding-004 (768 dimensions).
// Free tier: 1500 RPM. Returns null on failure (caller handles fallback).

const axios = require('axios');

const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';

async function embedText(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn('⚠️ GEMINI_API_KEY missing — embedding skipped');
    return null;
  }

  try {
    const response = await axios.post(
      `${EMBED_URL}?key=${key}`,
      { content: { parts: [{ text }] } },
      { timeout: 5000 }
    );
    const values = response.data?.embedding?.values;
    if (!Array.isArray(values) || values.length !== 768) {
      console.warn('⚠️ Unexpected embedding response shape');
      return null;
    }
    return values;
  } catch (err) {
    console.error('❌ Embedding failed:', err.message);
    return null;
  }
}

async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    const vec = await embedText(text);
    results.push(vec);
    // Rate limit pacing: 1500 RPM = ~40ms between calls
    await new Promise(r => setTimeout(r, 50));
  }
  return results;
}

module.exports = { embedText, embedBatch };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/rag/embed.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/embed.js tests/rag/embed.test.js
git commit -m "feat(rag): add Gemini embedding wrapper"
```

---

### Task 4: Extend Conversation model with RAG fields

**Files:**
- Modify: `models/Conversation.js`
- Create: `tests/rag/conversation-schema.test.js`

- [ ] **Step 1: Read current Conversation model**

Run: `cat /Users/kkaran/whatsapp-claude-bridge/models/Conversation.js`

- [ ] **Step 2: Write failing test for new fields**

Create `tests/rag/conversation-schema.test.js`:

```javascript
const Conversation = require('../../models/Conversation');

describe('Conversation RAG fields', () => {
  test('schema has outcome enum field', () => {
    const path = Conversation.schema.path('outcome');
    expect(path).toBeDefined();
    expect(path.enumValues).toEqual(['in_progress', 'sale', 'no_sale', 'abandoned']);
  });

  test('schema has embedded boolean field', () => {
    const path = Conversation.schema.path('embedded');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
  });

  test('schema has embeddingIds array', () => {
    const path = Conversation.schema.path('embeddingIds');
    expect(path).toBeDefined();
  });

  test('schema has outcomeAmount number', () => {
    const path = Conversation.schema.path('outcomeAmount');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Number');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/rag/conversation-schema.test.js`
Expected: FAIL (fields don't exist yet)

- [ ] **Step 4: Add fields to Conversation schema**

In `models/Conversation.js`, find the schema definition and add inside the `new mongoose.Schema({...})` block (before the closing `}`):

```javascript
  // RAG fields
  outcome: {
    type: String,
    enum: ['in_progress', 'sale', 'no_sale', 'abandoned'],
    default: 'in_progress',
    index: true
  },
  outcomeAmount: { type: Number, default: 0 },
  outcomeDetectedAt: Date,
  embedded: { type: Boolean, default: false, index: true },
  embeddingIds: { type: [String], default: [] },
  embeddingError: String,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/rag/conversation-schema.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add models/Conversation.js tests/rag/conversation-schema.test.js
git commit -m "feat(rag): add outcome, embedded, embeddingIds fields to Conversation"
```

---

### Task 5: Create RagFailure model

**Files:**
- Create: `models/RagFailure.js`
- Create: `tests/rag/rag-failure.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/rag/rag-failure.test.js`:

```javascript
const RagFailure = require('../../models/RagFailure');

describe('RagFailure model', () => {
  test('has failureType field', () => {
    expect(RagFailure.schema.path('failureType')).toBeDefined();
  });

  test('has customerPhone field', () => {
    expect(RagFailure.schema.path('customerPhone')).toBeDefined();
  });

  test('timestamp defaults to Date.now', () => {
    const path = RagFailure.schema.path('timestamp');
    expect(path).toBeDefined();
    expect(path.defaultValue).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/rag-failure.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Create model**

Create `models/RagFailure.js`:

```javascript
const mongoose = require('mongoose');

const ragFailureSchema = new mongoose.Schema({
  customerPhone: { type: String, index: true },
  customerMessage: String,
  failureType: {
    type: String,
    enum: ['embedding_error', 'no_retrieval', 'bad_retrieval', 'pinecone_timeout', 'classification_error'],
    required: true
  },
  context: { type: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now, index: true }
});

// Auto-cleanup after 30 days
ragFailureSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('RagFailure', ragFailureSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/rag/rag-failure.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add models/RagFailure.js tests/rag/rag-failure.test.js
git commit -m "feat(rag): add RagFailure model for debug logging"
```

---

### Task 6: Add RAG environment variables

**Files:**
- Modify: `.env` (local — already gitignored)
- Modify: `server.js` (CONFIG block)

- [ ] **Step 1: Read existing CONFIG block**

Run: `grep -n "CONFIG = {" /Users/kkaran/whatsapp-claude-bridge/server.js`

- [ ] **Step 2: Add new env vars to CONFIG**

In `server.js`, find the `CONFIG` object (around line 246) and add before the closing `}`:

```javascript
  // RAG configuration
  PINECONE_API_KEY: (process.env.PINECONE_API_KEY || '').trim(),
  PINECONE_INDEX: (process.env.PINECONE_INDEX || 'ninecork-conversations').trim(),
  RAG_ENABLED: process.env.RAG_ENABLED === 'true',
  RAG_RETRIEVAL_TIMEOUT_MS: parseInt(process.env.RAG_RETRIEVAL_TIMEOUT_MS || '2000'),
  ADMIN_WHATSAPP_NUMBER: (process.env.ADMIN_WHATSAPP_NUMBER || '').trim(),
  WEEKLY_REPORT_ENABLED: process.env.WEEKLY_REPORT_ENABLED === 'true',
```

- [ ] **Step 3: Update local .env**

Add to `/Users/kkaran/whatsapp-claude-bridge/.env`:

```
PINECONE_API_KEY=<paste from Pinecone dashboard>
PINECONE_INDEX=ninecork-conversations
RAG_ENABLED=false
RAG_RETRIEVAL_TIMEOUT_MS=2000
ADMIN_WHATSAPP_NUMBER=<your business phone with country code, no +>
WEEKLY_REPORT_ENABLED=false
```

- [ ] **Step 4: Verify env loads**

Run: `node -e "require('dotenv').config(); console.log('PINECONE:', !!process.env.PINECONE_API_KEY)"`
Expected: `PINECONE: true`

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(rag): add RAG config to server CONFIG block"
```

---

## PHASE 2 — Import Pipeline (Tasks 7-12)

### Task 7: Build WhatsApp chat parser

**Files:**
- Create: `rag/chat-parser.js`
- Create: `tests/rag/chat-parser.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/rag/chat-parser.test.js`:

```javascript
const { parseChat, extractQAPairs } = require('../../rag/chat-parser');

const SAMPLE = `[14/03/2026, 11:23:45 AM] Karan: hi
[14/03/2026, 11:24:02 AM] You: Hi! How many pieces are you looking for?
[14/03/2026, 11:24:30 AM] Karan: 100 coasters
[14/03/2026, 11:25:00 AM] You: Great! What's the budget per piece?`;

describe('chat-parser', () => {
  test('parseChat extracts messages with timestamps', () => {
    const messages = parseChat(SAMPLE, 'You');
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ role: 'customer', content: 'hi' });
    expect(messages[1]).toMatchObject({ role: 'business', content: 'Hi! How many pieces are you looking for?' });
  });

  test('parseChat handles 24-hour format', () => {
    const sample = `[14/03/2026, 23:45] Karan: hi\n[14/03/2026, 23:46] You: hello`;
    const messages = parseChat(sample, 'You');
    expect(messages).toHaveLength(2);
  });

  test('parseChat returns empty for invalid input', () => {
    expect(parseChat('', 'You')).toEqual([]);
    expect(parseChat(null, 'You')).toEqual([]);
  });

  test('extractQAPairs groups customer→business exchanges', () => {
    const messages = parseChat(SAMPLE, 'You');
    const pairs = extractQAPairs(messages);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({
      customerMessage: 'hi',
      botResponse: 'Hi! How many pieces are you looking for?'
    });
  });

  test('extractQAPairs handles consecutive customer messages', () => {
    const sample = `[14/03/2026, 11:00 AM] Karan: hi
[14/03/2026, 11:01 AM] Karan: are you there
[14/03/2026, 11:02 AM] You: yes hello`;
    const messages = parseChat(sample, 'You');
    const pairs = extractQAPairs(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].customerMessage).toContain('hi');
    expect(pairs[0].customerMessage).toContain('are you there');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/chat-parser.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement parser**

Create `rag/chat-parser.js`:

```javascript
// Parses WhatsApp exported .txt chat into structured messages.
// WhatsApp format: [DD/MM/YYYY, HH:MM AM/PM] Name: message
// "You" / your business number is the bot side; everything else is customer.

const MESSAGE_REGEX = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\]\s+([^:]+):\s*(.*)$/i;

function parseChat(text, businessName = 'You') {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split('\n');
  const messages = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(MESSAGE_REGEX);
    if (match) {
      if (current) messages.push(current);
      const [, dateStr, timeStr, sender, content] = match;
      current = {
        timestamp: parseTimestamp(dateStr, timeStr),
        sender: sender.trim(),
        role: sender.trim().toLowerCase() === businessName.toLowerCase() ? 'business' : 'customer',
        content: content.trim()
      };
    } else if (current && line.trim()) {
      current.content += '\n' + line.trim();
    }
  }
  if (current) messages.push(current);

  return messages;
}

function parseTimestamp(dateStr, timeStr) {
  const [d, m, y] = dateStr.split('/');
  const year = y.length === 2 ? `20${y}` : y;
  const isoDate = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  try {
    return new Date(`${isoDate} ${timeStr}`).getTime();
  } catch {
    return Date.now();
  }
}

function extractQAPairs(messages) {
  const pairs = [];
  let pendingCustomer = [];

  for (const msg of messages) {
    if (msg.role === 'customer') {
      pendingCustomer.push(msg.content);
    } else if (msg.role === 'business' && pendingCustomer.length > 0) {
      pairs.push({
        customerMessage: pendingCustomer.join(' | '),
        botResponse: msg.content,
        timestamp: msg.timestamp
      });
      pendingCustomer = [];
    }
  }

  return pairs;
}

module.exports = { parseChat, extractQAPairs };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/rag/chat-parser.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/chat-parser.js tests/rag/chat-parser.test.js
git commit -m "feat(rag): add WhatsApp chat parser"
```

---

### Task 8: Build Groq-based conversation classifier

**Files:**
- Create: `rag/classifier.js`
- Create: `tests/rag/classifier.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/rag/classifier.test.js`:

```javascript
jest.mock('groq-sdk');
const Groq = require('groq-sdk');
const { classifyConversation } = require('../../rag/classifier');

describe('classifier', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test';
    Groq.mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  outcome: 'sale',
                  saleAmount: 8200,
                  products: ['coasters'],
                  customerType: 'corporate',
                  budget: 50,
                  confidence: 0.9
                })
              }
            }]
          })
        }
      }
    }));
  });

  test('classifyConversation returns structured outcome', async () => {
    const messages = [
      { role: 'customer', content: 'Need 100 coasters' },
      { role: 'business', content: 'For corporate gifting?' },
      { role: 'customer', content: 'yes, paid' }
    ];
    const result = await classifyConversation(messages);
    expect(result.outcome).toBe('sale');
    expect(result.saleAmount).toBe(8200);
    expect(result.products).toContain('coasters');
  });

  test('classifyConversation marks low confidence as needsReview', async () => {
    Groq.mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ outcome: 'sale', confidence: 0.3 }) } }]
          })
        }
      }
    }));
    const result = await classifyConversation([{ role: 'customer', content: 'hi' }]);
    expect(result.needsReview).toBe(true);
  });

  test('returns default on Groq failure', async () => {
    Groq.mockImplementation(() => ({
      chat: { completions: { create: jest.fn().mockRejectedValue(new Error('down')) } }
    }));
    const result = await classifyConversation([{ role: 'customer', content: 'hi' }]);
    expect(result.outcome).toBe('in_progress');
    expect(result.needsReview).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/classifier.test.js`
Expected: FAIL

- [ ] **Step 3: Implement classifier**

Create `rag/classifier.js`:

```javascript
// Uses Groq to classify a conversation into outcome + metadata.

const Groq = require('groq-sdk');

const SYSTEM_PROMPT = `You are an expert sales analyst for 9 Cork Sustainable Products.
Analyze the conversation and return ONLY valid JSON with this exact shape:
{
  "outcome": "sale" | "no_sale" | "abandoned" | "in_progress",
  "saleAmount": <number in INR or 0>,
  "products": [<product names mentioned>],
  "customerType": "corporate" | "horeca" | "retail",
  "budget": <number per-piece in INR or 0>,
  "confidence": <0.0-1.0>
}
Rules:
- "sale" only if payment confirmed ("paid", "transferred", "payment done")
- "no_sale" if customer explicitly declined ("too expensive", "not interested")
- "abandoned" if customer ghosted >7 days after multiple questions
- "in_progress" if conversation is recent and ongoing
- confidence < 0.5 means you're unsure
- Return ONLY the JSON object, no markdown, no prose.`;

async function classifyConversation(messages) {
  if (!process.env.GROQ_API_KEY) {
    return defaultResult('Groq not configured');
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const conversationText = messages
    .map(m => `${m.role === 'customer' ? 'Customer' : 'You'}: ${m.content}`)
    .join('\n');

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: conversationText }
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return defaultResult('Empty response');

    const parsed = JSON.parse(content);
    return {
      outcome: parsed.outcome || 'in_progress',
      saleAmount: Number(parsed.saleAmount) || 0,
      products: Array.isArray(parsed.products) ? parsed.products : [],
      customerType: parsed.customerType || 'retail',
      budget: Number(parsed.budget) || 0,
      confidence: Number(parsed.confidence) || 0,
      needsReview: Number(parsed.confidence) < 0.5
    };
  } catch (err) {
    console.error('❌ Classifier error:', err.message);
    return defaultResult(err.message);
  }
}

function defaultResult(reason) {
  return {
    outcome: 'in_progress',
    saleAmount: 0,
    products: [],
    customerType: 'retail',
    budget: 0,
    confidence: 0,
    needsReview: true,
    error: reason
  };
}

module.exports = { classifyConversation };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/rag/classifier.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/classifier.js tests/rag/classifier.test.js
git commit -m "feat(rag): add Groq-based conversation classifier"
```

---

### Task 9: Build Pinecone indexer

**Files:**
- Create: `rag/indexer.js`
- Create: `tests/rag/indexer.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/rag/indexer.test.js`:

```javascript
jest.mock('../../rag/pinecone-client');
jest.mock('../../rag/embed');

const pineconeClient = require('../../rag/pinecone-client');
const embed = require('../../rag/embed');
const { indexQAPair, indexConversation } = require('../../rag/indexer');

describe('indexer', () => {
  let mockUpsert;

  beforeEach(() => {
    mockUpsert = jest.fn().mockResolvedValue({});
    pineconeClient.getIndex.mockReturnValue({ upsert: mockUpsert });
    pineconeClient.isConfigured.mockReturnValue(true);
    embed.embedText.mockResolvedValue(new Array(768).fill(0.1));
  });

  test('indexQAPair upserts vector with metadata', async () => {
    const result = await indexQAPair({
      customerPhone: '919876543210',
      customerMessage: 'need coasters',
      botResponse: 'how many?',
      timestamp: 1719945600,
      outcome: 'sale',
      products: ['coasters']
    });
    expect(result.success).toBe(true);
    expect(mockUpsert).toHaveBeenCalled();
    const upserted = mockUpsert.mock.calls[0][0];
    expect(upserted[0].metadata.outcome).toBe('sale');
    expect(upserted[0].values).toHaveLength(768);
  });

  test('indexQAPair skips if Pinecone not configured', async () => {
    pineconeClient.isConfigured.mockReturnValue(false);
    const result = await indexQAPair({ customerMessage: 'hi' });
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test('indexQAPair returns failure if embedding fails', async () => {
    embed.embedText.mockResolvedValue(null);
    const result = await indexQAPair({ customerMessage: 'hi' });
    expect(result.success).toBe(false);
  });

  test('indexConversation processes multiple QA pairs', async () => {
    const result = await indexConversation({
      customerPhone: '919876543210',
      qaPairs: [
        { customerMessage: 'hi', botResponse: 'hello', timestamp: 1 },
        { customerMessage: 'coasters?', botResponse: 'yes', timestamp: 2 }
      ],
      outcome: 'sale'
    });
    expect(result.indexed).toBe(2);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/indexer.test.js`
Expected: FAIL

- [ ] **Step 3: Implement indexer**

Create `rag/indexer.js`:

```javascript
// Writes embedded Q&A pairs to Pinecone with rich metadata.

const crypto = require('crypto');
const { getIndex, isConfigured } = require('./pinecone-client');
const { embedText } = require('./embed');

const STALE_PRICING_DAYS = 90;

function makeVectorId(customerPhone, timestamp, suffix = '') {
  const hash = crypto.createHash('md5').update(`${customerPhone}_${timestamp}_${suffix}`).digest('hex');
  return `vec_${hash.substring(0, 16)}`;
}

function isStaleForPricing(timestamp) {
  const ageMs = Date.now() - timestamp;
  return ageMs > STALE_PRICING_DAYS * 24 * 60 * 60 * 1000;
}

async function indexQAPair(pair) {
  if (!isConfigured()) {
    return { success: false, skipped: true, reason: 'Pinecone not configured' };
  }

  const embedInput = `Customer: ${pair.customerMessage}\nBot: ${pair.botResponse || ''}`;
  const vector = await embedText(embedInput);

  if (!vector) {
    return { success: false, reason: 'Embedding failed' };
  }

  const id = makeVectorId(pair.customerPhone || 'unknown', pair.timestamp || Date.now());
  const metadata = {
    customerPhone: pair.customerPhone || 'unknown',
    customerMessage: (pair.customerMessage || '').substring(0, 1000),
    botResponse: (pair.botResponse || '').substring(0, 1000),
    products: pair.products || [],
    quantity: Number(pair.quantity) || 0,
    budget: Number(pair.budget) || 0,
    outcome: pair.outcome || 'in_progress',
    saleAmount: Number(pair.saleAmount) || 0,
    timestamp: pair.timestamp || Date.now(),
    isStaleForPricing: isStaleForPricing(pair.timestamp || Date.now()),
    productStillAvailable: pair.productStillAvailable !== false,
    conversationStage: pair.conversationStage || 'unknown'
  };

  try {
    const index = getIndex();
    await index.upsert([{ id, values: vector, metadata }]);
    return { success: true, id };
  } catch (err) {
    console.error('❌ Pinecone upsert failed:', err.message);
    return { success: false, reason: err.message };
  }
}

async function indexConversation({ customerPhone, qaPairs, outcome, saleAmount, products, customerType, budget }) {
  let indexed = 0;
  const ids = [];

  for (const pair of qaPairs) {
    const result = await indexQAPair({
      ...pair,
      customerPhone,
      outcome,
      saleAmount,
      products,
      customerType,
      budget
    });
    if (result.success) {
      indexed++;
      ids.push(result.id);
    }
    await new Promise(r => setTimeout(r, 50));
  }

  return { indexed, total: qaPairs.length, ids };
}

module.exports = { indexQAPair, indexConversation, makeVectorId };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/rag/indexer.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/indexer.js tests/rag/indexer.test.js
git commit -m "feat(rag): add Pinecone indexer for Q&A pairs"
```

---

### Task 10: Build the bulk import script

**Files:**
- Create: `scripts/import-chats.js`
- Create: `data/past-chats/.gitkeep`

- [ ] **Step 1: Create data directory and gitkeep**

```bash
mkdir -p /Users/kkaran/whatsapp-claude-bridge/data/past-chats
touch /Users/kkaran/whatsapp-claude-bridge/data/past-chats/.gitkeep
echo "data/past-chats/*.txt" >> /Users/kkaran/whatsapp-claude-bridge/.gitignore
```

- [ ] **Step 2: Implement import script**

Create `scripts/import-chats.js`:

```javascript
#!/usr/bin/env node
// Bulk import past WhatsApp chats into Pinecone + MongoDB.
//
// Usage:
//   node scripts/import-chats.js [--batch=N] [--limit=N] [--dry-run]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { parseChat, extractQAPairs } = require('../rag/chat-parser');
const { classifyConversation } = require('../rag/classifier');
const { indexConversation } = require('../rag/indexer');
const Conversation = require('../models/Conversation');

const CHATS_DIR = path.join(__dirname, '..', 'data', 'past-chats');
const BUSINESS_NAME = process.env.IMPORT_BUSINESS_NAME || 'You';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    limit: parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity,
    batch: parseInt((args.find(a => a.startsWith('--batch=')) || '').split('=')[1]) || 0,
    dryRun: args.includes('--dry-run')
  };
}

function extractCustomerPhone(filename) {
  const match = filename.match(/(\d{2})[\s-]?(\d{5})[\s-]?(\d{5})/);
  if (match) return match[1] + match[2] + match[3];
  return 'unknown_' + filename.substring(0, 10);
}

async function run() {
  const opts = parseArgs();
  console.log('🚀 Starting chat import...');
  console.log(`   Dry-run: ${opts.dryRun}, Limit: ${opts.limit}`);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');

  if (!fs.existsSync(CHATS_DIR)) {
    console.error(`❌ Directory not found: ${CHATS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(CHATS_DIR)
    .filter(f => f.endsWith('.txt'))
    .slice(0, opts.limit);

  console.log(`📁 Found ${files.length} chat files`);

  const stats = {
    processed: 0, indexed: 0, skippedShort: 0, skippedNoBusiness: 0,
    needsReview: 0, sales: 0, noSales: 0, abandoned: 0,
    totalSaleValue: 0, productCounts: {}
  };

  const uncertainList = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    process.stdout.write(`\r🔄 [${i + 1}/${files.length}] ${file.substring(0, 50)}...`);

    try {
      const text = fs.readFileSync(path.join(CHATS_DIR, file), 'utf-8');
      const messages = parseChat(text, BUSINESS_NAME);

      if (messages.length < 5) { stats.skippedShort++; continue; }
      if (!messages.some(m => m.role === 'business')) { stats.skippedNoBusiness++; continue; }

      const qaPairs = extractQAPairs(messages);
      if (qaPairs.length === 0) { stats.skippedShort++; continue; }

      const customerPhone = extractCustomerPhone(file);
      const classification = await classifyConversation(messages);

      if (classification.needsReview) {
        stats.needsReview++;
        uncertainList.push({ file, classification });
      }

      if (classification.outcome === 'sale') {
        stats.sales++;
        stats.totalSaleValue += classification.saleAmount;
      } else if (classification.outcome === 'no_sale') stats.noSales++;
      else if (classification.outcome === 'abandoned') stats.abandoned++;

      for (const p of classification.products) {
        stats.productCounts[p] = (stats.productCounts[p] || 0) + 1;
      }

      if (opts.dryRun) { stats.processed++; continue; }

      const conversation = await Conversation.findOneAndUpdate(
        { customerPhone, status: 'completed' },
        {
          customerPhone, status: 'completed',
          outcome: classification.outcome,
          outcomeAmount: classification.saleAmount,
          outcomeDetectedAt: new Date(),
          messages: messages.map(m => ({
            role: m.role === 'business' ? 'agent' : 'customer',
            content: m.content,
            timestamp: new Date(m.timestamp)
          })),
          metadata: {
            productInterest: classification.products,
            budget: String(classification.budget),
            quantity: 0
          }
        },
        { upsert: true, new: true }
      );

      const indexResult = await indexConversation({
        customerPhone, qaPairs,
        outcome: classification.outcome,
        saleAmount: classification.saleAmount,
        products: classification.products,
        customerType: classification.customerType,
        budget: classification.budget
      });

      conversation.embedded = true;
      conversation.embeddingIds = indexResult.ids;
      await conversation.save();

      stats.indexed += indexResult.indexed;
      stats.processed++;
    } catch (err) {
      console.error(`\n❌ Error on ${file}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n');
  console.log('═'.repeat(50));
  console.log('  IMPORT COMPLETE');
  console.log('═'.repeat(50));
  console.log(`  Files processed:       ${stats.processed}`);
  console.log(`  Vectors indexed:       ${stats.indexed}`);
  console.log(`  Skipped (too short):   ${stats.skippedShort}`);
  console.log(`  Skipped (no business): ${stats.skippedNoBusiness}`);
  console.log('  Outcome breakdown:');
  console.log(`    Sales:        ${stats.sales} (₹${stats.totalSaleValue.toLocaleString('en-IN')})`);
  console.log(`    No-sales:     ${stats.noSales}`);
  console.log(`    Abandoned:    ${stats.abandoned}`);
  console.log(`    Needs review: ${stats.needsReview}`);
  console.log('  Top products:');
  const sorted = Object.entries(stats.productCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [p, n] of sorted) console.log(`    ${p}: ${n}`);

  if (uncertainList.length > 0) {
    const reviewPath = path.join(__dirname, '..', 'data', 'uncertain-review.json');
    fs.writeFileSync(reviewPath, JSON.stringify(uncertainList, null, 2));
    console.log(`\n  ⚠️  Review uncertain: node scripts/review-uncertain.js`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 3: Make executable**

```bash
chmod +x /Users/kkaran/whatsapp-claude-bridge/scripts/import-chats.js
```

- [ ] **Step 4: Smoke test with dry-run**

Drop 2-3 test .txt files into `data/past-chats/`, then:

Run: `cd /Users/kkaran/whatsapp-claude-bridge && node scripts/import-chats.js --dry-run --limit=3`
Expected: Prints summary with `Files processed: 3`, `Vectors indexed: 0` (dry-run skips upsert)

- [ ] **Step 5: Commit**

```bash
git add scripts/import-chats.js data/past-chats/.gitkeep .gitignore
git commit -m "feat(rag): add bulk chat import script"
```

---

### Task 11: Build uncertain-conversation review UI

**Files:**
- Create: `scripts/review-uncertain.js`

- [ ] **Step 1: Implement review script**

Create `scripts/review-uncertain.js`:

```javascript
#!/usr/bin/env node
// Terminal UI to manually review conversations with confidence < 0.5.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');

const REVIEW_FILE = path.join(__dirname, '..', 'data', 'uncertain-review.json');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

async function run() {
  if (!fs.existsSync(REVIEW_FILE)) {
    console.log('❌ No review file found. Run import-chats.js first.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const items = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf-8'));
  console.log(`📋 ${items.length} conversations to review\n`);

  for (let i = 0; i < items.length; i++) {
    const { file, classification } = items[i];
    console.log('─'.repeat(60));
    console.log(`[${i + 1}/${items.length}] ${file}`);
    console.log(`AI guess: outcome=${classification.outcome}, amount=₹${classification.saleAmount}`);
    console.log(`Confidence: ${classification.confidence}`);

    const choice = await ask('\n[a]pprove / [s]ale / [n]o_sale / [b]andoned / [k]ip > ');

    let newOutcome = classification.outcome;
    if (choice === 's') newOutcome = 'sale';
    else if (choice === 'n') newOutcome = 'no_sale';
    else if (choice === 'b') newOutcome = 'abandoned';
    else if (choice === 'k') continue;

    const phone = file.match(/(\d{10,12})/);
    if (phone) {
      await Conversation.updateMany(
        { customerPhone: { $regex: phone[1] } },
        { $set: { outcome: newOutcome, outcomeDetectedAt: new Date() } }
      );
      console.log(`  ✅ Updated outcome → ${newOutcome}`);
    }
  }

  fs.unlinkSync(REVIEW_FILE);
  console.log('\n✅ Review complete. File removed.');
  await mongoose.disconnect();
  rl.close();
}

run().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x /Users/kkaran/whatsapp-claude-bridge/scripts/review-uncertain.js
git add scripts/review-uncertain.js
git commit -m "feat(rag): add uncertain conversation review UI"
```

---

### Task 12: Run first batch import (manual verification)

- [ ] **Step 1: Drop first 50 WhatsApp chat exports into `data/past-chats/`**

- [ ] **Step 2: Verify business name matches your WhatsApp display name**

```bash
echo "IMPORT_BUSINESS_NAME=9 Cork Sustainable Products" >> .env
```

- [ ] **Step 3: Dry-run preview**

```bash
cd /Users/kkaran/whatsapp-claude-bridge
node scripts/import-chats.js --dry-run
```

Expected: Realistic outcome breakdown.

- [ ] **Step 4: Real import**

```bash
node scripts/import-chats.js
```

Expected: Vectors written to Pinecone, conversations to MongoDB.

- [ ] **Step 5: Verify in Pinecone dashboard**

Visit https://app.pinecone.io → `ninecork-conversations` index → vector count > 0.

- [ ] **Step 6: Review uncertain classifications**

```bash
node scripts/review-uncertain.js
```

---

## PHASE 3 — Live RAG (Tasks 13-17)

### Task 13: Build retriever (parallel Pinecone queries)

**Files:**
- Create: `rag/retriever.js`
- Create: `tests/rag/retriever.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/rag/retriever.test.js`:

```javascript
jest.mock('../../rag/pinecone-client');
jest.mock('../../rag/embed');

const pineconeClient = require('../../rag/pinecone-client');
const embed = require('../../rag/embed');
const { retrieveContext } = require('../../rag/retriever');

describe('retriever', () => {
  let mockQuery;

  beforeEach(() => {
    mockQuery = jest.fn().mockResolvedValue({
      matches: [
        { id: 'v1', score: 0.9, metadata: { customerMessage: 'past', botResponse: 'response', outcome: 'sale' } }
      ]
    });
    pineconeClient.getIndex.mockReturnValue({ query: mockQuery });
    pineconeClient.isConfigured.mockReturnValue(true);
    embed.embedText.mockResolvedValue(new Array(768).fill(0.1));
  });

  test('retrieveContext returns empty when RAG disabled', async () => {
    pineconeClient.isConfigured.mockReturnValue(false);
    const result = await retrieveContext({ message: 'hi', customerPhone: '919' });
    expect(result.customerHistory).toEqual([]);
    expect(result.similarConversations).toEqual([]);
  });

  test('retrieveContext returns parallel results', async () => {
    const result = await retrieveContext({ message: 'need coasters', customerPhone: '919876543210' });
    expect(result.similarConversations).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalled();
  });

  test('retrieveContext applies filters for pricing queries', async () => {
    await retrieveContext({ message: 'how much for 100 coasters', customerPhone: '919' });
    const calls = mockQuery.mock.calls;
    const pricingCall = calls.find(c => c[0].filter?.isStaleForPricing !== undefined);
    expect(pricingCall).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/retriever.test.js`
Expected: FAIL

- [ ] **Step 3: Implement retriever**

Create `rag/retriever.js`:

```javascript
// Retrieves relevant context for a customer message:
//  1. Customer's own past conversations (personalization)
//  2. Top-K similar successful conversations (learning)
//  3. Product-specific reference data
// Runs queries in parallel. Falls back gracefully on any failure.

const { getIndex, isConfigured } = require('./pinecone-client');
const { embedText } = require('./embed');

const PRICING_KEYWORDS = /\b(price|cost|how much|rate|₹|rs\.?|inr|budget|expensive|cheap)\b/i;

function isPricingQuery(message) {
  return PRICING_KEYWORDS.test(message);
}

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ matches: [], timedOut: true }), ms))
  ]);
}

async function retrieveContext({ message, customerPhone, timeoutMs = 2000 }) {
  if (!isConfigured()) {
    return { customerHistory: [], similarConversations: [], productContext: [], usedRAG: false };
  }

  const vector = await embedText(message);
  if (!vector) {
    return { customerHistory: [], similarConversations: [], productContext: [], usedRAG: false };
  }

  const index = getIndex();
  const pricing = isPricingQuery(message);

  const customerHistoryPromise = withTimeout(
    index.query({
      vector, topK: 3, includeMetadata: true,
      filter: { customerPhone: { $eq: customerPhone } }
    }).catch(() => ({ matches: [] })),
    timeoutMs
  );

  const similarFilter = { outcome: { $in: ['sale', 'in_progress'] } };
  if (pricing) {
    similarFilter.isStaleForPricing = { $eq: false };
    similarFilter.productStillAvailable = { $eq: true };
  }

  const similarPromise = withTimeout(
    index.query({
      vector, topK: 5, includeMetadata: true, filter: similarFilter
    }).catch(() => ({ matches: [] })),
    timeoutMs
  );

  const productPromise = withTimeout(
    index.query({
      vector, topK: 3, includeMetadata: true,
      filter: { outcome: { $eq: 'sale' } }
    }).catch(() => ({ matches: [] })),
    timeoutMs
  );

  const [history, similar, product] = await Promise.all([customerHistoryPromise, similarPromise, productPromise]);

  return {
    customerHistory: (history.matches || []).map(m => m.metadata),
    similarConversations: (similar.matches || []).map(m => m.metadata),
    productContext: (product.matches || []).map(m => m.metadata),
    usedRAG: true,
    timedOut: history.timedOut || similar.timedOut || product.timedOut
  };
}

module.exports = { retrieveContext, isPricingQuery };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/rag/retriever.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/retriever.js tests/rag/retriever.test.js
git commit -m "feat(rag): add parallel Pinecone retriever with smart filters"
```

---

### Task 14: Build context-builder

**Files:**
- Create: `rag/context-builder.js`
- Create: `tests/rag/context-builder.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/rag/context-builder.test.js`:

```javascript
const { buildRagContext, estimateTokens } = require('../../rag/context-builder');

describe('context-builder', () => {
  const sampleContext = {
    customerHistory: [
      { customerMessage: 'past coasters', botResponse: 'past response', outcome: 'sale', saleAmount: 5000 }
    ],
    similarConversations: [
      { customerMessage: 'similar 1', botResponse: 'reply 1', outcome: 'sale', products: ['coasters'], saleAmount: 6000 },
      { customerMessage: 'similar 2', botResponse: 'reply 2', outcome: 'sale', products: ['coasters'], saleAmount: 8000 }
    ],
    productContext: [
      { customerMessage: 'product ref', botResponse: 'product reply', products: ['planters'] }
    ],
    usedRAG: true
  };

  test('returns empty string when no RAG data', () => {
    const result = buildRagContext({
      customerHistory: [], similarConversations: [], productContext: [], usedRAG: false
    });
    expect(result).toBe('');
  });

  test('includes section headers', () => {
    const result = buildRagContext(sampleContext);
    expect(result).toContain('THIS CUSTOMER');
    expect(result).toContain('SIMILAR SUCCESSFUL');
  });

  test('respects max token budget', () => {
    const big = {
      customerHistory: [],
      similarConversations: new Array(50).fill({ customerMessage: 'x'.repeat(1000), botResponse: 'y'.repeat(1000), outcome: 'sale' }),
      productContext: [],
      usedRAG: true
    };
    const result = buildRagContext(big, { maxTokens: 1000 });
    expect(estimateTokens(result)).toBeLessThanOrEqual(1100);
  });

  test('estimateTokens approximates char count', () => {
    const tokens = estimateTokens('hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/context-builder.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `rag/context-builder.js`:

```javascript
// Assembles retrieved Pinecone matches into a prompt-injection string.

const DEFAULT_MAX_TOKENS = 14000;

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function formatExample(match, withOutcome = true) {
  const cm = (match.customerMessage || '').trim();
  const br = (match.botResponse || '').trim();
  const outcomeTag = withOutcome && match.outcome ? ` [${match.outcome}${match.saleAmount ? ` ₹${match.saleAmount}` : ''}]` : '';
  return `Customer: ${cm}\nResponse: ${br}${outcomeTag}`;
}

function buildSection(title, matches, maxTokens) {
  if (!matches || matches.length === 0) return '';
  let section = `\n═══ ${title} ═══\n`;
  let used = estimateTokens(section);
  for (const m of matches) {
    const example = formatExample(m);
    const cost = estimateTokens(example) + 5;
    if (used + cost > maxTokens) break;
    section += '\n' + example + '\n';
    used += cost;
  }
  return section;
}

function buildRagContext(retrievalResult, options = {}) {
  if (!retrievalResult || !retrievalResult.usedRAG) return '';
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const { customerHistory, similarConversations, productContext } = retrievalResult;
  const historyBudget = Math.floor(maxTokens * 0.25);
  const similarBudget = Math.floor(maxTokens * 0.5);
  const productBudget = Math.floor(maxTokens * 0.25);

  const parts = ['\n\n[RAG CONTEXT — Use these real past examples to inform your response]'];

  if (customerHistory?.length) parts.push(buildSection('THIS CUSTOMER\'S PAST INTERACTIONS', customerHistory, historyBudget));
  if (similarConversations?.length) parts.push(buildSection('SIMILAR SUCCESSFUL SALES', similarConversations, similarBudget));
  if (productContext?.length) parts.push(buildSection('PRODUCT REFERENCE EXAMPLES', productContext, productBudget));

  parts.push('\n[END RAG CONTEXT — Apply these patterns naturally; do NOT quote them verbatim]\n');
  return parts.join('');
}

module.exports = { buildRagContext, estimateTokens };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/rag/context-builder.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/context-builder.js tests/rag/context-builder.test.js
git commit -m "feat(rag): add token-budgeted context builder"
```

---

### Task 15: Hook RAG into ai-provider-manager

**Files:**
- Modify: `ai-provider-manager.js`

- [ ] **Step 1: Find getResponse method**

Run: `grep -n "getResponse" /Users/kkaran/whatsapp-claude-bridge/ai-provider-manager.js`

- [ ] **Step 2: Modify getResponse to accept ragContext parameter**

In `ai-provider-manager.js`, replace the existing `getResponse` method body with:

```javascript
  async getResponse(systemPrompt, conversationHistory, userMessage, userId = null, ragContext = '') {
    const cachedResponse = this.checkCache(userMessage, userId);
    if (cachedResponse) {
      console.log('⚡ Cache hit - instant response');
      return { provider: 'cache', response: cachedResponse };
    }

    const augmentedSystem = ragContext ? `${systemPrompt}\n\n${ragContext}` : systemPrompt;

    try {
      return await this.tryGroq(augmentedSystem, conversationHistory, userMessage, userId);
    } catch (error) {
      console.log('❌ Groq failed:', error.message);
    }

    try {
      return await this.tryGemini(augmentedSystem, conversationHistory, userMessage, userId);
    } catch (error) {
      console.log('❌ Gemini failed:', error.message);
    }

    const fallbackResponse = this.getFallbackResponse(userMessage);
    return { provider: 'fallback', response: fallbackResponse };
  }
```

- [ ] **Step 3: Verify syntax**

Run: `node --check /Users/kkaran/whatsapp-claude-bridge/ai-provider-manager.js`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add ai-provider-manager.js
git commit -m "feat(rag): accept ragContext in ai-provider-manager.getResponse"
```

---

### Task 16: Hook RAG into server.js webhook flow

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add RAG imports**

In `server.js`, near the top (around line 30, next to other requires):

```javascript
const { retrieveContext } = require('./rag/retriever');
const { buildRagContext } = require('./rag/context-builder');
```

- [ ] **Step 2: Add retrieval call in processWithClaudeAgent**

Find `async function processWithClaudeAgent(message, customerPhone, context = []) {` (around line 2117).

After `const systemPrompt = buildSystemPrompt(useMetadata);` and BEFORE `const contextAwareMessage = buildContextAwareMessage(sanitizedMessage, context);`:

```javascript
    let ragContext = '';
    if (CONFIG.RAG_ENABLED) {
      try {
        const retrieval = await retrieveContext({
          message: sanitizedMessage,
          customerPhone: sanitizedPhone,
          timeoutMs: CONFIG.RAG_RETRIEVAL_TIMEOUT_MS
        });
        ragContext = buildRagContext(retrieval);
        if (retrieval.usedRAG) {
          console.log(`📚 RAG: ${retrieval.similarConversations.length} similar, ${retrieval.customerHistory.length} customer history`);
        }
      } catch (err) {
        console.warn('⚠️ RAG retrieval failed (continuing without):', err.message);
      }
    }
```

- [ ] **Step 3: Pass ragContext to getResponse**

Replace the existing `aiManager.getResponse(...)` call with:

```javascript
    const result = await aiManager.getResponse(
      systemPrompt,
      contextWithFacts.slice(-50),
      contextAwareMessage,
      sanitizedPhone,
      ragContext
    );
```

- [ ] **Step 4: Verify syntax**

Run: `node --check /Users/kkaran/whatsapp-claude-bridge/server.js`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(rag): integrate retrieval into webhook flow with feature flag"
```

---

### Task 17: Add async indexer hook + deploy

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add indexer require**

In `server.js`, alongside the other RAG requires:

```javascript
const { indexQAPair } = require('./rag/indexer');
```

- [ ] **Step 2: Add async indexing after sending response**

Inside the message processor, after `await sendWhatsAppMessage(from, agentResponse);` and BEFORE `await handleImageDetectionAndSending(...)`:

```javascript
      if (CONFIG.RAG_ENABLED) {
        setImmediate(async () => {
          try {
            await indexQAPair({
              customerPhone: from,
              customerMessage: messageBody,
              botResponse: agentResponse,
              timestamp: Date.now(),
              outcome: 'in_progress',
              conversationStage: 'live'
            });
          } catch (err) {
            console.warn('⚠️ Async indexing failed:', err.message);
          }
        });
      }
```

- [ ] **Step 3: Verify syntax and push to Render**

Run: `node --check /Users/kkaran/whatsapp-claude-bridge/server.js`

```bash
git add server.js
git commit -m "feat(rag): async-index each new conversation"
git push origin main
```

- [ ] **Step 4: Set RAG env vars on Render**

In Render dashboard → service → Environment:
- `PINECONE_API_KEY` = (from Pinecone)
- `PINECONE_INDEX` = `ninecork-conversations`
- `RAG_ENABLED` = `false` (start disabled)
- `RAG_RETRIEVAL_TIMEOUT_MS` = `2000`

Wait for auto-deploy, then:
Run: `curl -s https://whatsapp-ai-agent-nico-messenger.onrender.com/health`
Expected: `status: ok`

- [ ] **Step 5: Enable RAG for live testing**

On Render: change `RAG_ENABLED` to `true`. Save → triggers redeploy.

Send "hi" via WhatsApp. Check Render logs for `📚 RAG:` line.

---

## PHASE 4 — Self-Improvement (Tasks 18-21)

### Task 18: Build outcome detector

**Files:**
- Create: `rag/outcome-detector.js`
- Create: `tests/rag/outcome-detector.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/rag/outcome-detector.test.js`:

```javascript
const { detectOutcome } = require('../../rag/outcome-detector');

describe('outcome-detector', () => {
  test('detects sale on payment confirmation', () => {
    const messages = [
      { role: 'customer', content: 'paid', timestamp: Date.now() },
      { role: 'agent', content: 'Total ₹8200', timestamp: Date.now() - 60000 }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('sale');
    expect(result.saleAmount).toBeGreaterThan(0);
  });

  test('detects no_sale on rejection', () => {
    const messages = [
      { role: 'customer', content: 'too expensive, sorry', timestamp: Date.now() }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('no_sale');
  });

  test('detects abandoned on long silence', () => {
    const messages = [
      { role: 'customer', content: 'how much', timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000 },
      { role: 'agent', content: '₹8200', timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000 }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('abandoned');
  });

  test('returns in_progress for recent active chat', () => {
    const messages = [
      { role: 'customer', content: 'hi', timestamp: Date.now() - 60000 },
      { role: 'agent', content: 'hello', timestamp: Date.now() - 30000 },
      { role: 'customer', content: 'I want coasters', timestamp: Date.now() - 10000 }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('in_progress');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rag/outcome-detector.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `rag/outcome-detector.js`:

```javascript
// Rule-based outcome detection. No AI — fast and deterministic.

const SALE_KEYWORDS = /\b(paid|payment done|transferred|sent the money|transaction complete|done payment)\b/i;
const NO_SALE_KEYWORDS = /\b(too expensive|too costly|not interested|will think|maybe later|cant afford|sorry)\b/i;
const ABANDONED_DAYS = 7;
const AMOUNT_REGEX = /₹\s*([\d,]+)|rs\.?\s*([\d,]+)|inr\s*([\d,]+)/i;

function detectOutcome(messages) {
  if (!messages || messages.length === 0) {
    return { outcome: 'in_progress', confidence: 0 };
  }

  const sorted = [...messages].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const lastMsg = sorted[0];
  const lastTimestamp = lastMsg.timestamp || Date.now();
  const daysSinceLast = (Date.now() - lastTimestamp) / (1000 * 60 * 60 * 24);

  const recentCustomer = sorted.filter(m => m.role === 'customer').slice(0, 5);
  for (const msg of recentCustomer) {
    if (SALE_KEYWORDS.test(msg.content)) {
      let saleAmount = 0;
      for (const m of sorted) {
        if (m.role === 'agent' || m.role === 'business') {
          const match = m.content.match(AMOUNT_REGEX);
          if (match) {
            saleAmount = parseInt((match[1] || match[2] || match[3]).replace(/,/g, ''));
            break;
          }
        }
      }
      return { outcome: 'sale', confidence: 0.9, saleAmount };
    }
    if (NO_SALE_KEYWORDS.test(msg.content)) {
      return { outcome: 'no_sale', confidence: 0.7, saleAmount: 0 };
    }
  }

  if (daysSinceLast > ABANDONED_DAYS && messages.length >= 5) {
    return { outcome: 'abandoned', confidence: 0.8, saleAmount: 0 };
  }

  return { outcome: 'in_progress', confidence: 0.5, saleAmount: 0 };
}

module.exports = { detectOutcome };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/rag/outcome-detector.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add rag/outcome-detector.js tests/rag/outcome-detector.test.js
git commit -m "feat(rag): add rule-based outcome detector"
```

---

### Task 19: Build weekly analysis cron

**Files:**
- Create: `scripts/weekly-cron.js`
- Modify: `server.js`

- [ ] **Step 1: Implement weekly-cron.js**

Create `scripts/weekly-cron.js`:

```javascript
// Monday 9 AM IST analysis: pull last 7 days, summarize via Groq, send WhatsApp report.

const axios = require('axios');
const Groq = require('groq-sdk');
const Conversation = require('../models/Conversation');
const { detectOutcome } = require('../rag/outcome-detector');

const ANALYSIS_PROMPT = `You are a sales operations analyst for 9 Cork Sustainable Products WhatsApp bot.
Analyze the conversations below and return ONLY valid JSON:
{
  "totalConversations": <N>,
  "salesClosed": <N>,
  "totalSaleValue": <INR>,
  "conversionRate": <0-100>,
  "topWins": [<3-5 short bullet strings>],
  "topIssues": [
    {"issue": "<one-liner>", "affected": <N>, "suggestedFix": "<short>", "autoApply": <bool>}
  ],
  "learnedThisWeek": <count>
}
Mark autoApply: true only for trivial copy/price-tier example additions.
Mark autoApply: false for structural sales-flow changes.`;

async function runWeeklyAnalysis(config) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const conversations = await Conversation.find({
    updatedAt: { $gte: sevenDaysAgo }
  }).lean();

  console.log(`📊 Weekly analysis: ${conversations.length} conversations`);

  let tagged = 0;
  for (const conv of conversations) {
    if (conv.outcome === 'in_progress' && conv.messages) {
      const detection = detectOutcome(conv.messages);
      if (detection.outcome !== 'in_progress' && detection.confidence > 0.6) {
        await Conversation.updateOne(
          { _id: conv._id },
          { outcome: detection.outcome, outcomeAmount: detection.saleAmount, outcomeDetectedAt: new Date() }
        );
        tagged++;
      }
    }
  }
  console.log(`   Tagged ${tagged} outcomes`);

  const sample = conversations.slice(0, 100).map(c => ({
    outcome: c.outcome,
    amount: c.outcomeAmount,
    messages: (c.messages || []).slice(0, 10).map(m => `${m.role}: ${(m.content || '').substring(0, 200)}`).join(' | ')
  }));

  const groq = new Groq({ apiKey: config.GROQ_API_KEY });
  let report;
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: JSON.stringify(sample) }
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    });
    report = JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error('❌ Analysis failed:', err.message);
    return;
  }

  const lines = [
    '📊 9 CORK BOT — WEEKLY REPORT',
    '',
    `CONVERSATIONS: ${report.totalConversations}`,
    `SALES: ${report.salesClosed} (₹${(report.totalSaleValue || 0).toLocaleString('en-IN')})`,
    `CONVERSION: ${(report.conversionRate || 0).toFixed(1)}%`,
    '',
    '🟢 TOP WINS:',
    ...((report.topWins || []).map(w => `• ${w}`)),
    '',
    '🔴 TOP ISSUES:'
  ];

  let autoApplyCount = 0;
  for (const [i, issue] of (report.topIssues || []).entries()) {
    lines.push(`${i + 1}. ${issue.issue} (${issue.affected})`);
    lines.push(`   Fix: ${issue.suggestedFix}`);
    if (issue.autoApply) autoApplyCount++;
  }

  if (autoApplyCount > 0) {
    lines.push('');
    lines.push(`🔧 ${autoApplyCount} fixes ready to auto-apply.`);
    lines.push(`   Reply "yes apply" to confirm.`);
  }

  const messageText = lines.join('\n');

  if (config.ADMIN_WHATSAPP_NUMBER) {
    const token = config.WHATSAPP_TOKEN.replace(/\s/g, '');
    try {
      await axios.post(
        `https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: config.ADMIN_WHATSAPP_NUMBER,
          type: 'text',
          text: { body: messageText.substring(0, 4000) }
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      console.log('✅ Weekly report sent to admin');
    } catch (err) {
      console.error('❌ Failed to send report:', err.response?.data || err.message);
    }
  }

  const fs = require('fs');
  const path = require('path');
  const reportDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const fname = `weekly-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(path.join(reportDir, fname), JSON.stringify({ ...report, generatedAt: new Date() }, null, 2));
}

module.exports = { runWeeklyAnalysis };

if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await runWeeklyAnalysis(process.env);
    await mongoose.disconnect();
  })().catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 2: Wire cron into server.js**

In `server.js`, near the bottom (after `app.listen(...)`), add:

```javascript
if (CONFIG.WEEKLY_REPORT_ENABLED) {
  const cron = require('node-cron');
  const { runWeeklyAnalysis } = require('./scripts/weekly-cron');
  cron.schedule('30 3 * * 1', async () => {
    console.log('🗓️ Running weekly analysis...');
    try {
      await runWeeklyAnalysis(CONFIG);
    } catch (err) {
      console.error('❌ Weekly cron error:', err.message);
    }
  });
  console.log('🗓️ Weekly cron scheduled: Monday 9 AM IST');
}
```

- [ ] **Step 3: Verify syntax**

Run: `node --check /Users/kkaran/whatsapp-claude-bridge/server.js`
Run: `node --check /Users/kkaran/whatsapp-claude-bridge/scripts/weekly-cron.js`
Expected: No errors

- [ ] **Step 4: Smoke test manually**

```bash
cd /Users/kkaran/whatsapp-claude-bridge
node scripts/weekly-cron.js
```

Expected: Runs analysis, sends WhatsApp message.

- [ ] **Step 5: Commit and enable on Render**

```bash
git add scripts/weekly-cron.js server.js
git commit -m "feat(rag): weekly analysis cron with WhatsApp report"
git push origin main
```

On Render: set `WEEKLY_REPORT_ENABLED=true` and `ADMIN_WHATSAPP_NUMBER`.

---

### Task 20: Build auto-apply mechanism

**Files:**
- Create: `scripts/apply-suggestion.js`

- [ ] **Step 1: Implement using execFileSync (safe, no shell)**

Create `scripts/apply-suggestion.js`:

```javascript
#!/usr/bin/env node
// Apply approved auto-fix suggestions to system-prompt.js.
// Reads latest report from data/reports/, applies fixes flagged autoApply: true,
// commits and pushes for Render to deploy.
//
// Uses execFileSync (NOT exec) to avoid shell injection risks.
//
// Usage: node scripts/apply-suggestion.js [--report=path] [--dry-run]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'system-prompt.js');
const REPO_ROOT = path.join(__dirname, '..');

function findLatestReport() {
  const dir = path.join(REPO_ROOT, 'data', 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('weekly-')).sort().reverse();
  return files[0] ? path.join(dir, files[0]) : null;
}

function applyTextAddition(promptText, addition, marker) {
  const anchor = 'REMEMBER: You KNOW all products';
  const anchorIdx = promptText.lastIndexOf(anchor);
  if (anchorIdx === -1) {
    console.warn('⚠️ Anchor not found in system prompt — refusing to modify');
    return null;
  }
  return promptText.slice(0, anchorIdx) +
    `\n[AUTO-APPLIED FIX ${marker}]\n${addition}\n\n` +
    promptText.slice(anchorIdx);
}

function gitCommitAndPush(message) {
  execFileSync('git', ['add', 'prompts/system-prompt.js'], { cwd: REPO_ROOT });
  execFileSync('git', ['commit', '-m', message], { cwd: REPO_ROOT });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO_ROOT });
}

function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const reportPath = (args.find(a => a.startsWith('--report=')) || '').split('=')[1] || findLatestReport();

  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error('❌ No report file found.');
    process.exit(1);
  }

  console.log(`📄 Loading report: ${path.basename(reportPath)}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const autoFixes = (report.topIssues || []).filter(i => i.autoApply);

  if (autoFixes.length === 0) {
    console.log('No auto-apply fixes in this report.');
    process.exit(0);
  }

  console.log(`Found ${autoFixes.length} auto-fix(es):`);
  for (const [i, fix] of autoFixes.entries()) {
    console.log(`  ${i + 1}. ${fix.issue} → ${fix.suggestedFix}`);
  }

  let prompt = fs.readFileSync(PROMPT_FILE, 'utf-8');
  const date = new Date().toISOString().split('T')[0];

  for (const fix of autoFixes) {
    const addition = `\n# Auto-fix (${date}): ${fix.issue}\n# Suggested behavior: ${fix.suggestedFix}\n`;
    const next = applyTextAddition(prompt, addition, `${date}-${autoFixes.indexOf(fix) + 1}`);
    if (next) prompt = next;
  }

  if (dryRun) {
    console.log('\n--- Modified prompt preview (dry-run) ---');
    const idx = prompt.indexOf('AUTO-APPLIED');
    console.log(prompt.substring(idx, idx + 500));
    process.exit(0);
  }

  fs.writeFileSync(PROMPT_FILE, prompt);

  try {
    gitCommitAndPush(`auto-fix(rag): apply ${autoFixes.length} suggestions from ${date}`);
    console.log('✅ Applied, committed, and pushed.');
  } catch (err) {
    console.error('❌ Git operations failed:', err.message);
    process.exit(1);
  }
}

run();
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x /Users/kkaran/whatsapp-claude-bridge/scripts/apply-suggestion.js
git add scripts/apply-suggestion.js
git commit -m "feat(rag): add safe apply-suggestion script using execFileSync"
```

---

### Task 21: Add /rag-stats monitoring endpoint

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add endpoint near other monitoring routes**

In `server.js`, find `app.get('/health'` (around line 2332) and add right after:

```javascript
app.get('/rag-stats', monitoringLimiter, async (req, res) => {
  try {
    const Conversation = require('./models/Conversation');
    const RagFailure = require('./models/RagFailure');

    const [total, sales, embedded, recentFailures] = await Promise.all([
      Conversation.countDocuments({}),
      Conversation.countDocuments({ outcome: 'sale' }),
      Conversation.countDocuments({ embedded: true }),
      RagFailure.find({ timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean()
    ]);

    res.json({
      status: 'ok',
      ragEnabled: CONFIG.RAG_ENABLED,
      conversations: { total, sales, embedded },
      conversionRate: total > 0 ? ((sales / total) * 100).toFixed(1) + '%' : 'N/A',
      recentFailures: recentFailures.length,
      failures: recentFailures.slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Verify syntax and push**

Run: `node --check /Users/kkaran/whatsapp-claude-bridge/server.js`

```bash
git add server.js
git commit -m "feat(rag): add /rag-stats monitoring endpoint"
git push origin main
```

- [ ] **Step 3: Verify on Render**

Run: `curl -s https://whatsapp-ai-agent-nico-messenger.onrender.com/rag-stats`
Expected: JSON with conversation counts.

---

## PHASE 5 — Production Hardening (Tasks 22-23)

### Task 22: Add npm test scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add test scripts**

In `package.json`, find the `"scripts"` block and add:

```json
"test:rag": "jest tests/rag/ --verbose",
"test:all": "jest"
```

- [ ] **Step 2: Run full RAG test suite**

Run: `cd /Users/kkaran/whatsapp-claude-bridge && npm run test:rag`
Expected: All RAG tests pass

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(rag): add npm test:rag and test:all scripts"
```

---

### Task 23: Write operational runbook

**Files:**
- Create: `docs/rag-runbook.md`

- [ ] **Step 1: Write runbook**

Create `docs/rag-runbook.md`:

```markdown
# RAG System — Operational Runbook

## Quick reference

| Endpoint | Purpose |
|---|---|
| `/health` | Overall server health |
| `/rag-stats` | RAG-specific metrics |

| Env var | Purpose |
|---|---|
| `RAG_ENABLED` | Master switch (true/false) |
| `RAG_RETRIEVAL_TIMEOUT_MS` | Max wait for Pinecone (default 2000) |
| `WEEKLY_REPORT_ENABLED` | Send Monday WhatsApp report |
| `ADMIN_WHATSAPP_NUMBER` | Where weekly report is sent |

## Common operations

### Disable RAG (emergency rollback)
On Render: set `RAG_ENABLED=false` → save. Bot falls back to old behavior.

### Re-import past chats
1. Drop `.txt` files in `data/past-chats/`
2. `node scripts/import-chats.js --dry-run` preview
3. `node scripts/import-chats.js` real
4. `node scripts/review-uncertain.js` borderline cases

### Manually trigger weekly report
`node scripts/weekly-cron.js`

### Apply weekly auto-fixes
`node scripts/apply-suggestion.js --dry-run` then without `--dry-run`

### Check Pinecone vector count
Visit https://app.pinecone.io → `ninecork-conversations` → records tab

## Troubleshooting

### Bot responses don't improve
- Check `/rag-stats` — is `embedded > 0`?
- Check Render logs for `📚 RAG:` lines
- Verify `RAG_ENABLED=true` on Render

### Weekly report not arriving
- Verify `WEEKLY_REPORT_ENABLED=true`
- Verify `ADMIN_WHATSAPP_NUMBER` set correctly
- Check Render logs Monday 3:30 AM UTC for `🗓️ Running weekly analysis`

### Pinecone errors in logs
- Check Pinecone dashboard for usage limits
- Verify `PINECONE_API_KEY` matches dashboard

### RAG latency spike
- Lower `RAG_RETRIEVAL_TIMEOUT_MS` to 1000 to fail fast
- Check Pinecone region (us-east-1-aws fastest from Mumbai)
```

- [ ] **Step 2: Commit**

```bash
git add docs/rag-runbook.md
git commit -m "docs(rag): add operational runbook"
```

---

## Final verification checklist

After all tasks complete:

- [ ] Run full test suite: `npm test`
- [ ] Hit `/rag-stats` endpoint — confirms RAG online
- [ ] Send test WhatsApp message — verify retrieval logs appear on Render
- [ ] Check `/data/reports/` after first Monday — confirms cron fired
- [ ] Verify Pinecone vector count grows after each conversation
- [ ] Verify `embedded: true` on new MongoDB conversations

---

## Rollout summary

| Phase | Tasks | Outcome |
|---|---|---|
| Phase 1 (Foundation) | 1-6 | Schema + clients ready, no behavior change |
| Phase 2 (Import) | 7-12 | 300+ past chats indexed to Pinecone |
| Phase 3 (Live RAG) | 13-17 | Bot uses retrieval per message |
| Phase 4 (Self-Improve) | 18-21 | Auto-tagging + weekly report |
| Phase 5 (Hardening) | 22-23 | Monitoring + runbook |

Total: 23 tasks, ~115 steps.
