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
 * Usage:
 *   node scripts/backfill-phone-hash.js            # apply
 *   node scripts/backfill-phone-hash.js --dry-run  # report only, no writes
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { phoneBlindIndex } = require('../mongodb-encryption');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');

const DRY_RUN = process.argv.includes('--dry-run');
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();

async function backfillCustomers() {
  const docs = await Customer.find({ phoneHash: { $exists: false } });
  console.log(`\n👤 Customers missing phoneHash: ${docs.length}`);
  let migrated = 0, dupsDeleted = 0, errors = 0;

  for (const c of docs) {
    // c.phoneNumber is plaintext here — post-find decrypt hook already ran
    // (and legacy plaintext values pass through decrypt unchanged).
    const plain = c.phoneNumber;
    if (!plain) { continue; }

    if (DRY_RUN) {
      console.log(`  would set phoneHash for ${String(plain).slice(-4)} (${c._id})`);
      migrated++;
      continue;
    }

    c.phoneHash = phoneBlindIndex(plain);
    c.markModified('phoneNumber'); // force the encryption hook to run on legacy plaintext
    try {
      await c.save();
      migrated++;
    } catch (e) {
      if (e.code === 11000) {
        // Duplicate phoneHash → this is a surplus Customer doc from the bug era.
        await Customer.deleteOne({ _id: c._id });
        dupsDeleted++;
      } else {
        errors++;
        console.error(`  ❌ Customer ${c._id}:`, e.message);
      }
    }
  }
  console.log(`   migrated=${migrated} duplicatesDeleted=${dupsDeleted} errors=${errors}`);
}

async function backfillConversations() {
  const docs = await Conversation.find({ phoneHash: { $exists: false } });
  console.log(`\n💬 Conversations missing phoneHash: ${docs.length}`);
  let migrated = 0, errors = 0;

  for (const conv of docs) {
    const plain = conv.customerPhone;
    if (!plain) { continue; }

    if (DRY_RUN) {
      console.log(`  would set phoneHash for ${String(plain).slice(-4)} (${conv._id})`);
      migrated++;
      continue;
    }

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
  console.log(`   migrated=${migrated} errors=${errors}`);
}

async function main() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI not set. Aborting.');
    process.exit(1);
  }
  console.log(`🔗 Connecting to MongoDB${DRY_RUN ? ' (DRY RUN — no writes)' : ''}...`);
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✅ Connected');

  await backfillCustomers();
  await backfillConversations();

  await mongoose.connection.close();
  console.log('\n✅ Backfill complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
