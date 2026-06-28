#!/usr/bin/env node
// Audits MongoDB Product categories vs the catalogPatterns / PRODUCT_KEYWORDS
// in server.js, surfacing gaps where the bot can't find images for known catalog products.

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const data = require('../data/pricing.json');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  // 1. Get all distinct Product categories (these have images)
  const dbCategories = await Product.distinct('category');
  const dbCounts = {};
  for (const c of dbCategories) {
    dbCounts[c] = await Product.countDocuments({ category: c });
  }
  console.log('=== Product collection (MongoDB — has images) ===');
  Object.entries(dbCounts).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log('  ' + c.padEnd(40) + n + ' products'));
  console.log();

  // 2. Get all distinct catalog categories (these have prices, from Google Sheets sync)
  const catalogCats = new Set();
  for (const p of (data.horeca || [])) if (p.category) catalogCats.add(p.category);
  for (const p of (data.catalogue || [])) if (p.category) catalogCats.add(p.category);
  console.log('=== data/pricing.json (Google Sheets — has prices) ===');
  [...catalogCats].sort().forEach(c => console.log('  ' + c));
  console.log();

  // 3. Surface categories in pricing.json that have NO match in MongoDB
  console.log('=== Catalog categories with NO MongoDB images ===');
  const dbLower = dbCategories.map(c => c.toLowerCase());
  for (const c of catalogCats) {
    const lower = c.toLowerCase();
    const tokens = lower.split(/[\s/&\-,]+/).filter(t => t.length > 2);
    const hasMatch = dbLower.some(dbc => tokens.some(t => dbc.includes(t)));
    if (!hasMatch) console.log('  ❌ ' + c);
  }
  console.log();

  // 4. Specific gap check — wall mirrors
  console.log('=== Wall mirror products in catalogue (for image gap check) ===');
  const mirrors = (data.catalogue || []).filter(p => /mirror/i.test(p.name || ''));
  mirrors.forEach(p => console.log('  ' + p.name + ' MRP ₹' + p.price));
  const mirrorImages = await Product.find({ name: { $regex: 'mirror', $options: 'i' } }).select('name images').limit(20);
  console.log('Mirror products in MongoDB with images:');
  if (mirrorImages.length === 0) console.log('  ❌ NONE — bot has no mirror images to send');
  else mirrorImages.forEach(p => console.log('  ' + p.name + ' (' + (p.images?.length || 0) + ' images)'));

  await mongoose.disconnect();
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
