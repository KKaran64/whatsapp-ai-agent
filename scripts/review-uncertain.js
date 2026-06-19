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
