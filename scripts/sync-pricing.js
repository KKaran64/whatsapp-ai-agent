#!/usr/bin/env node
// Sync pricing from Google Sheets → data/pricing.json
//
// Pulls 4 sheets (catalogue, combos, trophies, horeca), normalizes, writes JSON.
// Run manually: node scripts/sync-pricing.js
// Run via cron: scheduled in server.js if PRICING_SYNC_ENABLED=true

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'pricing.json');

// Google Sheet IDs (from share links)
const SHEETS = {
  catalogue: '19mA0s2VYAyiDCJ0M-7VgvXXnSQbUk31HQa4U3sMw6HY',  // Cork Gifting Catalogue
  combos:    '1Dxk9QnniE6WDASj2SBTdfesqYY7knpyfRzZUwTDMuwE',  // Cork Combo Price List
  trophies:  '14pafWDZsAxPqA5gQHprfH7pvQCuP0EVjEF0_U4XvnjQ',  // Cork Trophy Catalogue
  horeca:    '1THVTSBXIzdoY-kC12JKAIRcM7vKzU-rsDNV31ctQ_Dc'   // HORECA Catalogue
};

function sheetCsvUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

async function fetchCsv(id) {
  const url = sheetCsvUrl(id);
  const res = await axios.get(url, { maxRedirects: 5, timeout: 15000 });
  return res.data;
}

// Minimal CSV parser — handles quoted fields with commas
function parseCsv(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        cells.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    rows.push(cells.map(s => s.trim()));
  }
  return rows;
}

// Strip ₹, commas, whitespace from price string
function parsePrice(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[₹,\s]/g, '');
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

// Parse the HORECA sheet (cleanest structure)
// Columns: Product ID, PRODUCT NAME, Category, PRICE FOR 100-500 pcs (bulk), PRICE FOR 100-500 pcs (retail/MRP)
function parseHoreca(rows) {
  const products = [];
  let headerSeen = false;
  for (const row of rows) {
    if (!headerSeen) {
      if (row[0] && row[0].toLowerCase().includes('product id')) headerSeen = true;
      continue;
    }
    const [id, name, category, bulkPrice, mrpPrice] = row;
    if (!id || !name) continue;
    products.push({
      productId: id.trim(),
      name: name.trim(),
      category: (category || '').trim(),
      bulkPrice: parsePrice(bulkPrice),
      mrpPrice: parsePrice(mrpPrice)
    });
  }
  return products;
}

// Parse general catalogue sheet
// Columns: PRODUCT NAME, DIMENSION, PRICE FOR 100-200 MOQ
function parseCatalogue(rows) {
  const products = [];
  let currentCategory = '';
  let headerSeen = false;
  for (const row of rows) {
    if (!headerSeen) {
      if (row[0] && row[0].toLowerCase().includes('product name')) headerSeen = true;
      continue;
    }
    const [name, dimension, price] = row;
    if (!name) continue;
    // Category headers have no dimension or price
    if (!dimension && !price && name) {
      currentCategory = name.trim();
      continue;
    }
    products.push({
      name: name.trim(),
      dimension: (dimension || '').trim(),
      category: currentCategory,
      price: parsePrice(price)
    });
  }
  return products;
}

// Parse combos sheet — combos are multi-row entries
// Columns: COMBO, PRODUCT IMAGE, PRODUCTS NAME, MRP PRICE, COMBO PRICE
function parseCombos(rows) {
  const combos = [];
  let currentCombo = null;
  let headerSeen = false;
  for (const row of rows) {
    if (!headerSeen) {
      if (row[0] && row[0].toLowerCase().includes('combo')) headerSeen = true;
      continue;
    }
    const [comboName, , productName, mrp, comboPrice] = row;
    if (comboName && /^COMBO\s*\d+/i.test(comboName)) {
      // New combo
      if (currentCombo) combos.push(currentCombo);
      currentCombo = {
        name: comboName.trim(),
        items: [],
        comboPrice: parsePrice(comboPrice)
      };
      if (productName) {
        currentCombo.items.push({ name: productName.trim(), mrp: parsePrice(mrp) });
      }
    } else if (currentCombo && productName) {
      currentCombo.items.push({ name: productName.trim(), mrp: parsePrice(mrp) });
    }
  }
  if (currentCombo) combos.push(currentCombo);
  return combos;
}

// Parse trophies sheet
// Columns: Sr. No, IMAGE, Product code, Product Name, Price for 100
function parseTrophies(rows) {
  const products = [];
  let headerSeen = false;
  for (const row of rows) {
    if (!headerSeen) {
      if (row[0] && row[0].toLowerCase().includes('sr')) headerSeen = true;
      continue;
    }
    const [, , code, name, price] = row;
    if (!name) continue;
    products.push({
      productCode: (code || '').trim(),
      name: name.trim(),
      price: parsePrice(price)
    });
  }
  return products;
}

async function syncAll() {
  console.log('📥 Fetching pricing from Google Sheets...');

  const data = {
    syncedAt: new Date().toISOString(),
    source: 'google-sheets',
    catalogue: [],
    horeca: [],
    combos: [],
    trophies: []
  };

  try {
    const csv = await fetchCsv(SHEETS.catalogue);
    data.catalogue = parseCatalogue(parseCsv(csv));
    console.log(`  ✓ Catalogue: ${data.catalogue.length} products`);
  } catch (err) {
    console.error('  ✗ Catalogue failed:', err.message);
  }

  try {
    const csv = await fetchCsv(SHEETS.horeca);
    data.horeca = parseHoreca(parseCsv(csv));
    console.log(`  ✓ HORECA: ${data.horeca.length} products`);
  } catch (err) {
    console.error('  ✗ HORECA failed:', err.message);
  }

  try {
    const csv = await fetchCsv(SHEETS.combos);
    data.combos = parseCombos(parseCsv(csv));
    console.log(`  ✓ Combos: ${data.combos.length} combos`);
  } catch (err) {
    console.error('  ✗ Combos failed:', err.message);
  }

  try {
    const csv = await fetchCsv(SHEETS.trophies);
    data.trophies = parseTrophies(parseCsv(csv));
    console.log(`  ✓ Trophies: ${data.trophies.length} products`);
  } catch (err) {
    console.error('  ✗ Trophies failed:', err.message);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`💾 Wrote ${OUTPUT_FILE}`);

  return data;
}

module.exports = { syncAll, parsePrice };

if (require.main === module) {
  syncAll().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
