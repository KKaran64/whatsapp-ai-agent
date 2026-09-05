#!/usr/bin/env node
// Find and repair Product documents whose price could not be a real price.
//
//   node scripts/fix-implausible-prices.js            # dry run (default)
//   node scripts/fix-implausible-prices.js --apply    # write
//
// Written after CORK YOGA PEANUT reached production at ₹35,04,50,550. The
// sheet encodes its three sizes in one row (DIMENSION "S,M,L", PRICE
// "583,750,916") and the importer stripped the commas, turning three prices
// into one nine-digit number. The parser is fixed, but the corrupt document
// stays until something repairs it: the importer only replaces images on
// existing products, never their price.
//
// Deliberately general rather than a peanut-specific patch — it finds any
// product above the plausibility ceiling, so the next bad import surfaces
// here instead of sitting unnoticed in the collection.
//
// The replacement price is taken from the sheets, never invented: the
// importer's supplemental prices are the same source the product was created
// from. A product with no sheet price is reported for a human, not guessed.

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const { MAX_PLAUSIBLE_UNIT_PRICE } = require('../pricing/money');

const APPLY = process.argv.includes('--apply');

// Sizes are quoted per size; a single product doc that stands for a whole
// size range carries the smallest as a "from" price.
function chooseReplacement(candidates) {
  const prices = candidates.map(c => c.price).filter(p => Number.isFinite(p) && p > 0);
  if (!prices.length) return null;
  return Math.min(...prices);
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set.');
    process.exit(1);
  }
  console.log(APPLY ? 'Mode: APPLY (writing)' : 'Mode: DRY RUN (pass --apply to write)');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  const bad = await Product.find(
    { price: { $gt: MAX_PLAUSIBLE_UNIT_PRICE } },
    { name: 1, price: 1, productId: 1 }
  ).lean();

  console.log(`\nProducts priced above ₹${MAX_PLAUSIBLE_UNIT_PRICE.toLocaleString('en-IN')}: ${bad.length}`);
  if (!bad.length) {
    console.log('Nothing to repair.');
    await mongoose.disconnect();
    return;
  }

  // Variant prices for the affected products, read from the live sheets via
  // the importer's own parsing so this cannot drift from it.
  const { collectSupplementalPrices } = require('./import-image-links');
  let sheetPrices = new Map();
  try {
    sheetPrices = await collectSupplementalPrices();
  } catch (err) {
    console.warn(`⚠️  Could not read sheets (${err.message}) — will report only.`);
  }

  const norm = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  let repaired = 0;

  for (const p of bad) {
    const base = norm(p.name);
    const matches = [...sheetPrices.entries()]
      .filter(([k]) => k === base || k.startsWith(base + ' '))
      .map(([k, v]) => ({ name: k, price: v.price }));

    const replacement = chooseReplacement(matches);
    console.log(`\n  ${p.name}  (${p.productId || 'no id'})`);
    console.log(`    current : ₹${Number(p.price).toLocaleString('en-IN')}`);
    if (matches.length) {
      console.log(`    sheet   : ${matches.map(m => `${m.name} ₹${m.price}`).join(', ')}`);
    }
    if (replacement === null) {
      console.log('    -> NO sheet price found. Needs a human — not guessing.');
      continue;
    }
    console.log(`    -> ₹${replacement.toLocaleString('en-IN')}${matches.length > 1 ? ' (lowest variant, "from" price)' : ''}`);
    if (APPLY) {
      await Product.updateOne({ _id: p._id }, { $set: { price: replacement } });
      repaired++;
    }
  }

  console.log(APPLY ? `\n✅ Repaired ${repaired} product(s).` : '\nDry run — nothing written. Re-run with --apply.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
