#!/usr/bin/env node
// Purge Pinecone vectors belonging to the test phone number(s) from tonight's
// debugging. These contain inconsistent quotes + GST double-counting + dropped
// requirements — exactly the kind of bad data we never want re-ingested as a
// "successful sale example."
//
// Usage:
//   node scripts/purge-test-vectors.js                   → dry-run preview (default)
//   node scripts/purge-test-vectors.js --confirm         → actually delete
//   node scripts/purge-test-vectors.js --phone=91...     → custom phone(s), comma-separated

require('dotenv').config();
const { getIndex, isConfigured } = require('../rag/pinecone-client');
const { embedText } = require('../rag/embed');

const DEFAULT_PHONES = ['917696234000'];

async function listMatchingVectors(index, phones) {
  // Pinecone serverless requires query-then-delete (filter-only delete is pod-only).
  // Use a zero vector so the query is purely metadata-filtered.
  // topK is capped at 10000 — should be plenty for tonight's test conversations.
  const placeholderVec = new Array(1024).fill(0);
  const all = [];
  for (const phone of phones) {
    const res = await index.query({
      vector: placeholderVec,
      topK: 10000,
      includeMetadata: true,
      filter: { customerPhone: { $eq: phone } }
    });
    const matches = res?.matches || [];
    matches.forEach(m => all.push({
      id: m.id,
      phone: m.metadata?.customerPhone,
      outcome: m.metadata?.outcome,
      timestamp: m.metadata?.timestamp,
      preview: (m.metadata?.customerMessage || '').substring(0, 60)
    }));
  }
  return all;
}

async function run() {
  if (!isConfigured()) {
    console.error('❌ PINECONE_API_KEY not set in .env');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const phoneArg = args.find(a => a.startsWith('--phone='));
  const phones = phoneArg ? phoneArg.split('=')[1].split(',') : DEFAULT_PHONES;

  console.log(`📞 Target phone(s): ${phones.join(', ')}`);
  console.log(`🔍 Mode: ${confirm ? 'DELETE (--confirm flag set)' : 'DRY RUN (default safe)'}`);
  console.log('');

  const index = getIndex();
  const matches = await listMatchingVectors(index, phones);

  if (matches.length === 0) {
    console.log('No vectors found for the target phone(s). Nothing to purge.');
    process.exit(0);
  }

  console.log(`Found ${matches.length} vector(s):`);
  for (const m of matches.slice(0, 20)) {
    const d = m.timestamp ? new Date(m.timestamp).toISOString() : '(no ts)';
    console.log(`  ${m.id}  outcome=${m.outcome}  ${d}  "${m.preview}"`);
  }
  if (matches.length > 20) console.log(`  ...and ${matches.length - 20} more`);
  console.log('');

  if (!confirm) {
    console.log('⚠️  Dry run only. To actually delete, re-run with --confirm flag.');
    process.exit(0);
  }

  console.log(`🗑️  Deleting ${matches.length} vectors...`);
  const ids = matches.map(m => m.id);
  // Pinecone's deleteMany accepts an array of IDs. Batch in 100s to avoid limits.
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    await index.deleteMany(slice);
    console.log(`  deleted ${Math.min(i + BATCH, ids.length)} / ${ids.length}`);
  }
  console.log('✅ Purge complete.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
