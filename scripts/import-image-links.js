#!/usr/bin/env node
// Import product image links from Google Sheets (2026-07-06; pricing sheets added 2026-07-07).
//
// DRY-RUN BY DEFAULT — prints a full match report and writes nothing.
// Pass --apply to actually upsert MongoDB Product docs and write
// data/combo-images.json.
//
// Behavior:
//   - Google Drive viewer links are converted to direct-download form
//     (https://drive.google.com/uc?export=download&id=ID) — verified to
//     serve image bytes publicly; whatsapp-media-upload.js already
//     allowlists drive.google.com.
//   - Existing Mongo products (matched by normalized name): images REPLACED
//     with the sheet's links.
//   - New products: created only when a price exists in data/pricing.json
//     (Product.price is required — we never invent a price). Otherwise
//     reported as SKIPPED (no price).
//   - Combos sheet → data/combo-images.json (combo → components → images).
//
// Usage:
//   node scripts/import-image-links.js            # dry run
//   node scripts/import-image-links.js --apply    # write

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Product = require('../models/Product');

const APPLY = process.argv.includes('--apply');

// --sheet combos,catalogue-prices   → run only those labels (comma-separated).
// Omit to run all sheets.
const SHEET_FILTER = new Set(
  process.argv.includes('--sheet')
    ? process.argv[process.argv.indexOf('--sheet') + 1].split(',')
    : (process.argv.find(a => a.startsWith('--sheet='))?.slice(8) ?? '').split(',').filter(Boolean)
);

const SHEETS = [
  { label: 'combos',    docId: '1GW3OhlA30ga71D5SPj2iDtWNwN-OxFPL', gid: '1382734033', kind: 'combos' },
  { label: 'catalogue', docId: '1xow9hvPnmG39fO3-kAWlIpp1hhJfNpE0', gid: '1747788995', kind: 'products' },
  { label: 'trophies',  docId: '1iQ5spYZHNTaUTPGKqPqBLnFqCeu64wLU', gid: '311714520',  kind: 'coded' },
  { label: 'planters',  docId: '1S6b4sajZ2uyes3eTMm0jpLpLnI0GcwHr', gid: '1470534021', kind: 'horeca',  altKind: 'products' },
  { label: 'horeca',    docId: '13yTYNhK56bXIgAqDbaofb117arRSwHnV', gid: '1338387833', kind: 'products' },
  { label: 'yoga',      docId: '1BbW7imZ-spoK9LSNovcTBFr96Yj349Hg', gid: '1944483244', kind: 'coded' },
  // Pricing sheets — supplemental prices for Mongo product creation ONLY.
  // All columns are banded trade prices, NOT MRPs — deliberately NOT fed into
  // data/pricing.json (the quote engine discounts MRPs; banded prices would
  // double-discount). Supplemental prices fill priceIdx gaps only.
  { label: 'yoga-prices',      docId: '1uabe1TwYZaItnDHjfx_tDatl1sF_eUFNlkdtNBuq1jo', gid: '0',          kind: 'pricelist' },
  { label: 'horeca-prices',    docId: '19mA0s2VYAyiDCJ0M-7VgvXXnSQbUk31HQa4U3sMw6HY', gid: '308270010',  kind: 'pricelist' },
  { label: 'trophies-prices',  docId: '14pafWDZsAxPqA5gQHprfH7pvQCuP0EVjEF0_U4XvnjQ',  gid: '1661831986', kind: 'pricelist' },
  // Combo-pricing sheet has "PRODUCTS NAME" (plural) header — handled separately.
  { label: 'combos-prices',    docId: '1Dxk9QnniE6WDASj2SBTdfesqYY7knpyfRzZUwTDMuwE',  gid: '0',          kind: 'combopricelist' },
  { label: 'catalogue-prices', docId: '1THVTSBXIzdoY-kC12JKAIRcM7vKzU-rsDNV31ctQ_Dc',  gid: '1028285259', kind: 'pricelist' },
];

// ── tiny CSV parser (handles quoted fields with commas) ──
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Google intermittently 401s anonymous CSV exports. If IMAGE_SHEETS_CACHE is
// set, fall back to `${IMAGE_SHEETS_CACHE}/${docId}_${gid}.csv` on any fetch
// failure so a throttle can't block an import run.
async function fetchCsv(docId, gid) {
  try {
    return await fetchCsvNetwork(docId, gid);
  } catch (err) {
    const cacheDir = process.env.IMAGE_SHEETS_CACHE;
    if (cacheDir) {
      const f = path.join(cacheDir, `${docId}_${gid}.csv`);
      if (fs.existsSync(f)) {
        console.log(`  (network failed: ${err.message} — using cache ${path.basename(f)})`);
        return fs.readFileSync(f, 'utf-8');
      }
    }
    throw err;
  }
}

function fetchCsvNetwork(docId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
  return new Promise((resolve, reject) => {
    const get = (u, hops = 0) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      https.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        let data = '';
        res.on('data', d => (data += d));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    get(url);
  });
}

// Drive viewer link → direct-download link. Non-Drive URLs pass through.
function driveDirect(url) {
  const m = String(url || '').match(/drive\.google\.com\/file\/d\/([\w-]+)/)
    || String(url || '').match(/[?&]id=([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : (url || '').trim();
}

function isLink(v) {
  return /^https?:\/\//i.test(String(v || '').trim());
}

// Sheet data contains font/OCR artifacts: Ǫ (U+01EA) where Q is meant
// ("SǪUARE", "ǪR"), and sometimes G where & is meant ("PEN G MOBILE").
// Ǫ→Q is unambiguous — normalize always. G↔& is ambiguous, so it is only
// tried as a FALLBACK lookup (never stored).
const norm = s => String(s || '')
  .replace(/Ǫ/g, 'Q').replace(/ǫ/g, 'q')
  .toUpperCase().replace(/\s+/g, ' ').trim();

// Known sheet typos → canonical names (user-confirmed 2026-07-06).
const KNOWN_TYPOS = {
  'BAR CADDY G': 'BAR CADDY 6'
};

// Fallback name variants for price/Mongo lookup only.
function lookupVariants(name) {
  const v = [name];
  if (KNOWN_TYPOS[name]) v.push(KNOWN_TYPOS[name]);
  if (/ G /.test(name)) v.push(name.replace(/ G /g, ' & '));
  return v;
}
function findIn(map, name) {
  for (const v of lookupVariants(name)) {
    const hit = map.get(v);
    if (hit) return { hit, canonical: v };
  }
  return null;
}

// ── per-kind row extraction → { name, code?, category?, images[] } ──
function extractProducts(rows, kind) {
  // Find the header row (first row containing 'PRODUCT NAME')
  const headerIdx = rows.findIndex(r => r.some(c => /PRODUCT NAME/i.test(c)));
  if (headerIdx === -1) return [];
  const header = rows[headerIdx].map(c => c.trim().toUpperCase());
  const col = label => header.findIndex(h => h === label);
  const nameCol = col('PRODUCT NAME');
  const codeCol = header.findIndex(h => /PRODUCT ?(CODE|ID)/.test(h));
  const catCol = col('CATEGORY');
  const imgCols = header.map((h, i) => (/PRODUCT IMAGE/.test(h) ? i : -1)).filter(i => i >= 0);

  const out = [];
  let currentCategory = null;
  for (const r of rows.slice(headerIdx + 1)) {
    const name = (r[nameCol] || '').trim();
    if (!name) continue;
    const images = imgCols.map(i => r[i]).filter(isLink).map(driveDirect);
    if (images.length === 0) {
      // Section-header row (e.g. "CORK COASTER" in the horeca sheet)
      if (kind === 'horeca' || kind === 'products') currentCategory = norm(name);
      continue;
    }
    out.push({
      name: norm(name),
      code: codeCol >= 0 ? (r[codeCol] || '').trim() || null : null,
      category: catCol >= 0 ? norm(r[catCol]) || currentCategory : currentCategory,
      images: [...new Set(images)]
    });
  }
  return out;
}

function extractCombos(rows) {
  const headerIdx = rows.findIndex(r => r.some(c => /PRODUCTS NAME/i.test(c)));
  if (headerIdx === -1) return {};
  const header = rows[headerIdx].map(c => c.trim().toUpperCase());
  const comboCol = header.findIndex(h => h === 'COMBO');
  const nameCol = header.findIndex(h => /PRODUCTS NAME/.test(h));
  const linkCol = header.findIndex(h => /IMAGE LINK/.test(h));

  const combos = {};
  let current = null, section = null;
  for (const r of rows.slice(headerIdx + 1)) {
    const comboCell = (r[comboCol] || '').trim();
    const name = (r[nameCol] || '').trim();
    const link = (r[linkCol] || '').trim();
    if (comboCell && !/^COMBO\s*\d+/i.test(comboCell)) { section = norm(comboCell); continue; }
    if (comboCell) {
      current = norm(comboCell);
      combos[current] = { section, components: [] };
    }
    if (current && name) {
      combos[current].components.push({
        name: norm(name),
        image: isLink(link) ? driveDirect(link) : null
      });
    }
  }
  return combos;
}

// ── price lookup from the deterministic catalog ──
function buildPriceIndex() {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'pricing.json'), 'utf-8'));
  const idx = new Map();
  for (const p of catalog.horeca || []) if (p.name && p.mrpPrice) idx.set(norm(p.name), { price: p.mrpPrice, id: p.productId });
  for (const p of catalog.catalogue || []) if (p.name && p.price) idx.set(norm(p.name), { price: p.price, id: null });
  for (const p of catalog.trophies || []) if (p.name && p.price) idx.set(norm(p.name), { price: p.price, id: p.productCode });
  return idx;
}

function slugId(name) {
  return 'IMG-' + norm(name).replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

async function main() {
  const sheetsList = SHEET_FILTER.size > 0 ? `  Sheets: ${[...SHEET_FILTER].join(', ')}` : '  (all sheets)';
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes; pass --apply to write)'}${sheetsList}\n`);

  // 1. Fetch + parse all sheets
  const products = new Map(); // norm name → merged record
  const supplementalPrices = new Map(); // norm name → { price, id }
  let comboData = {};
  for (const s of SHEETS) {
    if (SHEET_FILTER.size > 0 && !SHEET_FILTER.has(s.label)) continue;
    const csv = await fetchCsv(s.docId, s.gid);
    const rows = parseCsv(csv);
    if (s.kind === 'combos') {
      comboData = extractCombos(rows);
      console.log(`sheet ${s.label}: ${Object.keys(comboData).length} combos`);
      continue;
    }
    if (s.kind === 'combopricelist') {
      // Combo-pricing sheet uses "PRODUCTS NAME" (plural) — extract per-component
      // MRP prices as supplemental prices for individual product creation.
      const headerIdx = rows.findIndex(r => r.some(c => /PRODUCTS? NAME/i.test(c)));
      if (headerIdx === -1) { console.log(`sheet ${s.label}: header not found, skipped`); continue; }
      const header = rows[headerIdx].map(c => c.trim().toUpperCase());
      const nameCol = header.findIndex(h => /^PRODUCTS? NAME$/.test(h));
      const priceCol = header.findIndex(h => /PRICE/.test(h));
      if (nameCol === -1 || priceCol === -1) { console.log(`sheet ${s.label}: name/price columns not found, skipped`); continue; }
      let count = 0;
      for (const r of rows.slice(headerIdx + 1)) {
        const name = norm(r[nameCol] || '');
        const price = Number(String(r[priceCol] || '').replace(/[^\d.]/g, ''));
        if (name && Number.isFinite(price) && price > 0 && !supplementalPrices.has(name)) {
          supplementalPrices.set(name, { price, id: null });
          count++;
        }
      }
      console.log(`sheet ${s.label}: ${count} supplemental prices from combo components`);
      continue;
    }
    if (s.kind === 'pricelist') {
      const headerIdx = rows.findIndex(r => r.some(c => /PRODUCT NAME/i.test(c)));
      const header = rows[headerIdx].map(c => c.trim().toUpperCase());
      const nameCol = header.findIndex(h => h === 'PRODUCT NAME');
      // trophies sheet uses "Product code" column name
      const idCol = header.findIndex(h => /PRODUCT ?(ID|CODE)/.test(h));
      const priceCol = header.findIndex(h => /PRICE/.test(h));
      let count = 0;
      for (const r of rows.slice(headerIdx + 1)) {
        const name = norm(r[nameCol]);
        const price = Number(String(r[priceCol] || '').replace(/[^\d.]/g, ''));
        if (name && Number.isFinite(price) && price > 0) {
          supplementalPrices.set(name, { price, id: (r[idCol] || '').trim() || null });
          count++;
        }
      }
      console.log(`sheet ${s.label}: ${count} supplemental prices`);
      continue;
    }
    const items = extractProducts(rows, s.kind);
    for (const it of items) {
      const prev = products.get(it.name);
      if (prev) {
        prev.images = [...new Set([...prev.images, ...it.images])];
        prev.code = prev.code || it.code;
        prev.category = prev.category || it.category;
      } else {
        products.set(it.name, it);
      }
    }
    console.log(`sheet ${s.label}: ${items.length} product rows`);
  }
  console.log(`\nTotal unique products across sheets: ${products.size}`);

  // 2. Match against MongoDB
  await mongoose.connect(process.env.MONGODB_URI);
  const existing = await Product.find({}, { name: 1, images: 1, productId: 1 }).lean();
  const byName = new Map(existing.map(p => [norm(p.name), p]));
  // Second match key: productId. A sheet row whose name doesn't match but
  // whose code already exists in Mongo is the SAME product under a name
  // variant — update it, never create a duplicate.
  const byId = new Map(existing.filter(p => p.productId).map(p => [String(p.productId).toUpperCase(), p]));
  const mongoMatch = (name, it) => {
    const hit = findIn(byName, name);
    if (hit) return hit;
    if (it.code && byId.has(it.code.toUpperCase())) {
      const doc = byId.get(it.code.toUpperCase());
      return { hit: doc, canonical: norm(doc.name) };
    }
    return null;
  };
  console.log(`MongoDB products: ${existing.length}`);

  const priceIdx = buildPriceIndex();
  // Supplemental prices fill gaps only — pricing.json stays authoritative.
  for (const [name, val] of supplementalPrices) {
    if (!priceIdx.has(name)) priceIdx.set(name, val);
  }
  const report = { update: [], create: [], skipNoPrice: [] };

  for (const [name, it] of products) {
    const mongoHit = mongoMatch(name, it);
    if (mongoHit) {
      report.update.push({ name: mongoHit.canonical, images: it.images.length, had: (mongoHit.hit.images || []).length });
    } else {
      const priced = findIn(priceIdx, name);
      if (priced) report.create.push({ name: priced.canonical, images: it.images.length, price: priced.hit.price, productId: it.code || priced.hit.id || slugId(priced.canonical), category: it.category || 'UNCATEGORIZED' });
      else report.skipNoPrice.push({ name, images: it.images.length });
    }
  }

  console.log(`\n=== REPORT ===`);
  console.log(`UPDATE (name matched in Mongo, images replaced): ${report.update.length}`);
  console.log(`CREATE (new, price found in pricing.json):       ${report.create.length}`);
  console.log(`SKIP   (new but NO price — needs human):         ${report.skipNoPrice.length}`);
  if (report.skipNoPrice.length) {
    console.log(`\nSkipped (no price):`);
    report.skipNoPrice.forEach(x => console.log(`  - ${x.name} (${x.images} imgs)`));
  }
  console.log(`\nCombos parsed: ${Object.keys(comboData).length} (→ data/combo-images.json)`);

  // 3. Apply
  if (APPLY) {
    let updated = 0, created = 0;
    for (const [name, it] of products) {
      const mongoHit = mongoMatch(name, it);
      if (mongoHit) {
        await Product.updateOne({ _id: mongoHit.hit._id }, { $set: { images: it.images, 'metadata.updatedAt': new Date() } });
        updated++;
      } else {
        const priced = findIn(priceIdx, name);
        if (!priced) continue;
        // Upsert keyed on productId — fully idempotent, immune to duplicate-key
        // aborts if two sheet rows (or a prior partial run) share a code.
        await Product.updateOne(
          { productId: it.code || priced.hit.id || slugId(priced.canonical) },
          {
            $set: { images: it.images, 'metadata.updatedAt': new Date() },
            $setOnInsert: {
              name: priced.canonical,
              category: it.category || 'UNCATEGORIZED',
              price: priced.hit.price,
              source: 'image-links-sheets-2026-07-06'
            }
          },
          { upsert: true }
        );
        created++;
      }
    }
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'combo-images.json'), JSON.stringify(comboData, null, 2));
    console.log(`\nAPPLIED: ${updated} updated, ${created} created, combo-images.json written`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
