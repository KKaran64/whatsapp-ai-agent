#!/usr/bin/env node
// Purge a test phone's MongoDB conversation history.
//
// The conversation context (last 50 messages) is injected into every LLM call as
// chat history. If those messages contain bad bot responses (wrong-priced quotes),
// the bot pattern-matches off them and reproduces the same mistakes — even with
// a perfect system prompt. This script wipes the history clean.
//
// Usage:
//   node scripts/purge-test-conversation.js                   → dry-run preview
//   node scripts/purge-test-conversation.js --confirm         → actually delete
//   node scripts/purge-test-conversation.js --phone=91...     → custom phone

require('dotenv').config();
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');

const DEFAULT_PHONE = '917696234000';

async function run() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const phoneArg = args.find(a => a.startsWith('--phone='));
  const phone = phoneArg ? phoneArg.split('=')[1] : DEFAULT_PHONE;

  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI not set in .env');
    process.exit(1);
  }

  console.log(`📞 Target phone: ${phone}`);
  console.log(`🔍 Mode: ${confirm ? 'DELETE (--confirm flag set)' : 'DRY RUN (default safe)'}`);
  console.log('');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const convos = await Conversation.find({ customerPhone: phone });
  console.log(`Found ${convos.length} conversation document(s) for this phone.`);

  let totalMessages = 0;
  for (const c of convos) {
    const msgCount = c.messages?.length || 0;
    totalMessages += msgCount;
    console.log(`  _id=${c._id}  status=${c.status}  messages=${msgCount}`);
    if (msgCount > 0 && c.messages.length > 0) {
      const last = c.messages[c.messages.length - 1];
      const lastContent = (last.content || '').substring(0, 80);
      console.log(`    last msg: [${last.role}] "${lastContent}..."`);
    }
  }

  console.log('');
  console.log(`Total messages across all conversations: ${totalMessages}`);

  if (!confirm) {
    console.log('');
    console.log('⚠️  Dry run only. To actually delete, re-run with --confirm.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (convos.length === 0) {
    console.log('Nothing to delete.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`🗑️  Deleting ${convos.length} conversation(s) (${totalMessages} messages total)...`);
  const result = await Conversation.deleteMany({ customerPhone: phone });
  console.log(`✅ Deleted ${result.deletedCount} conversation document(s).`);

  await mongoose.disconnect();
  console.log('');
  console.log('Done. NOTE: The in-memory cache on the Render server may still hold');
  console.log('the conversation until the next process restart. You can force a restart');
  console.log('by pushing any small commit or manually restarting on Render dashboard.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
