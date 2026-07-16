#!/usr/bin/env node
/**
 * One-time backfill: populate `phoneHash` (blind index) on existing Customer and
 * Conversation docs, and ensure their phone field is encrypted at rest.
 *
 * Why this is needed: phone-number encryption + blind-index lookup was added
 * after data already existed. Legacy docs have a plaintext phone and no
 * phoneHash, so hash-based lookups won't find them until they're backfilled.
 *
 * Safe to re-run (idempotent): only touches docs missing phoneHash.
 *
 * The earlier encryption bug created DUPLICATE Customer docs (one per message).
 * Customer.phoneHash is unique, so duplicates collide on save — this script
 * deletes the surplus duplicates (Customer docs are thin: phone + timestamps).
 * Conversation.phoneHash is NOT unique, so conversation duplicates are left
 * intact (that's a separate, pre-existing concern).
 *
 * Two ways to run:
 *   1. CLI (connects itself):
 *        node scripts/backfill-phone-hash.js            # apply
 *        node scripts/backfill-phone-hash.js --dry-run  # report only, no writes
 *   2. In-process (mongoose already connected — e.g. from server.js):
 *        const { runBackfill } = require('./scripts/backfill-phone-hash');
 *        await runBackfill({ dryRun });                 // returns a summary object
 *      This path reuses the caller's connection and encryption keys, so it runs
 *      correctly inside the deployed process (where the prod keys already live).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { phoneBlindIndex } = require('../mongodb-encryption');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');

async function backfillCustomers(dryRun) {
  const docs = await Customer.find({ phoneHash: { $exists: false } });
  let migrated = 0, duplicatesDeleted = 0, errors = 0;

  for (const c of docs) {
    // c.phoneNumber is plaintext here — post-find decrypt hook already ran
    // (and legacy plaintext values pass through decrypt unchanged).
    const plain = c.phoneNumber;
    if (!plain) { continue; }

    if (dryRun) { migrated++; continue; }

    c.phoneHash = phoneBlindIndex(plain);
    c.markModified('phoneNumber'); // force the encryption hook to run on legacy plaintext
    try {
      await c.save();
      migrated++;
    } catch (e) {
      if (e.code === 11000) {
        // Duplicate phoneHash → this is a surplus Customer doc from the bug era.
        await Customer.deleteOne({ _id: c._id });
        duplicatesDeleted++;
      } else {
        errors++;
        console.error(`  ❌ Customer ${c._id}:`, e.message);
      }
    }
  }

  const summary = { missing: docs.length, migrated, duplicatesDeleted, errors };
  console.log(`👤 Customers:`, JSON.stringify(summary));
  return summary;
}

async function backfillConversations(dryRun) {
  const docs = await Conversation.find({ phoneHash: { $exists: false } });
  let migrated = 0, errors = 0;

  for (const conv of docs) {
    const plain = conv.customerPhone;
    if (!plain) { continue; }

    if (dryRun) { migrated++; continue; }

    conv.phoneHash = phoneBlindIndex(plain);
    conv.markModified('customerPhone'); // force encryption of legacy plaintext
    try {
      await conv.save();
      migrated++;
    } catch (e) {
      errors++;
      console.error(`  ❌ Conversation ${conv._id}:`, e.message);
    }
  }

  const summary = { missing: docs.length, migrated, errors };
  console.log(`💬 Conversations:`, JSON.stringify(summary));
  return summary;
}

/**
 * Core migration. Assumes an active mongoose connection. Never calls
 * process.exit() or closes the connection, so it is safe to invoke from within
 * the running server. Returns a structured summary.
 */
async function runBackfill({ dryRun = false } = {}) {
  const customers = await backfillCustomers(dryRun);
  const conversations = await backfillConversations(dryRun);
  return { dryRun, customers, conversations };
}

// CLI entry point — connects, runs, disconnects. Only when invoked directly.
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI not set. Aborting.');
    process.exit(1);
  }
  console.log(`🔗 Connecting to MongoDB${dryRun ? ' (DRY RUN — no writes)' : ''}...`);
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✅ Connected');

  await runBackfill({ dryRun });

  await mongoose.connection.close();
  console.log('\n✅ Backfill complete.');
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Backfill failed:', err);
    process.exit(1);
  });
}

module.exports = { runBackfill, backfillCustomers, backfillConversations };
