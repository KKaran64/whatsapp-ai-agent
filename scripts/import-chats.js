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
        { customerPhone, status: 'closed' },
        {
          customerPhone, status: 'closed',
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
