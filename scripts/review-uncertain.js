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

// Mirror of extractCustomerPhone from scripts/import-chats.js so review keys match
// what was actually written to MongoDB during import.
function extractCustomerPhone(filename) {
  const match = filename.match(/(\d{2})[\s-]?(\d{5})[\s-]?(\d{5})/);
  if (match) return match[1] + match[2] + match[3];
  return 'unknown_' + filename.substring(0, 10);
}

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

    // Resolve the same customerPhone key the import script wrote with
    const customerPhone = extractCustomerPhone(file);
    const result = await Conversation.updateMany(
      { customerPhone: { $eq: customerPhone } },
      { $set: { outcome: newOutcome, outcomeDetectedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log(`  ✅ Updated outcome → ${newOutcome} (${result.modifiedCount} record)`);
    } else {
      console.log(`  ⚠️ No MongoDB record found for ${customerPhone} — skipped`);
    }
  }

  fs.unlinkSync(REVIEW_FILE);
  console.log('\n✅ Review complete. File removed.');
  await mongoose.disconnect();
  rl.close();
}

run().catch(err => { console.error(err); process.exit(1); });
