#!/usr/bin/env node
// Reconcile data/drive-manifest.json against the Drive folders the business
// actually maintains.
//
//   node scripts/refresh-drive-manifest.js            # write the manifest
//   node scripts/refresh-drive-manifest.js --check    # report only, exit 1 on drift
//
// Why a committed manifest instead of resolving at request time:
//   - Deterministic. The bot never depends on Drive being reachable, and a
//     Google throttle cannot blank the catalogue list mid-conversation.
//   - Reviewable. A changed catalogue shows up as a diff.
//   - Still self-correcting: --check run on a schedule turns "the wellness
//     catalogue was replaced and nobody noticed" into a failing job.
//
// This exists because pinned ids drift. The 2026-09 catalogue outage was
// three dead ids plus six slots never configured; within hours of pinning
// fresh ids, one was already stale — the wellness catalogue had been
// re-uploaded as "(2)" replacing "(5)", and the bot went on serving the old
// file because it still resolved.

const fs = require('fs');
const path = require('path');
const { listFolder, pickNewest } = require('../lib/drive-folder');

const MANIFEST = path.join(__dirname, '..', 'data', 'drive-manifest.json');

// WhatsApp rejects documents above 100 MB; warn before the ceiling.
const SIZE_WARN_BYTES = 90 * 1024 * 1024;

const CATALOGUE_FOLDER = '1MqtPv8XMvfMhIwzbm6jHAAGK4Cw3QKxL'; // 9 CORK_CATALOGUES_2026

// Slot → filename pattern. Order matters: the yoga catalogue is literally
// named "CORK YOGA WELLNESS PRODUCT CATALOGUE", so it must be claimed before
// the generic PRODUCTS pattern can swallow it.
const CATALOGUE_SLOTS = [
  ['YOGA',       /yoga|wellness/i],
  ['HORECA',     /horeca/i],
  ['COMBOS',     /combo/i],
  ['TROPHY',     /trophy/i],
  ['PLANTERS',   /planter/i],
  ['ELEVATION',  /elevation/i],
  ['MINIMALIST', /minimalist/i],
  ['FESTIVE',    /festive/i],
  ['PRODUCTS',   /product\s+catalogue/i]
];

function fmtMB(b) { return (b / 1048576).toFixed(1) + ' MB'; }

async function build() {
  const files = await listFolder(CATALOGUE_FOLDER);
  const pdfs = files.filter(f => f.mime === 'application/pdf');

  const catalogues = {};
  const claimed = new Set();
  const warnings = [];

  for (const [slot, pattern] of CATALOGUE_SLOTS) {
    const available = pdfs.filter(f => !claimed.has(f.id));
    const hit = pickNewest(available, pattern);
    if (!hit) {
      warnings.push(`no file in Drive matches slot ${slot} (${pattern})`);
      continue;
    }
    claimed.add(hit.id);
    catalogues[slot] = {
      id: hit.id,
      name: hit.name,
      sizeBytes: hit.sizeBytes,
      modifiedMs: hit.modifiedMs
    };
    if (hit.sizeBytes > SIZE_WARN_BYTES) {
      warnings.push(`${slot} is ${fmtMB(hit.sizeBytes)} — close to WhatsApp's 100 MB document limit`);
    }
  }

  const unclaimed = pdfs.filter(f => !claimed.has(f.id));
  for (const f of unclaimed) {
    warnings.push(`unmapped file in Drive (no slot will ever send it): "${f.name}"`);
  }

  return {
    manifest: {
      generatedAt: new Date().toISOString(),
      source: `https://drive.google.com/drive/folders/${CATALOGUE_FOLDER}`,
      catalogues
    },
    warnings
  };
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')); } catch { return null; }
}

// Compare only what the bot actually uses — regenerating for a timestamp
// change would make every run look like drift.
function diff(oldM, newM) {
  const out = [];
  const a = (oldM && oldM.catalogues) || {};
  const b = newM.catalogues;
  for (const slot of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[slot], y = b[slot];
    if (!x && y) out.push(`+ ${slot}: now "${y.name}"`);
    else if (x && !y) out.push(`- ${slot}: no longer resolvable`);
    else if (x.id !== y.id) out.push(`~ ${slot}: "${x.name}" -> "${y.name}"`);
  }
  return out;
}

async function main() {
  const check = process.argv.includes('--check');
  let built;
  try {
    built = await build();
  } catch (err) {
    // Never write a partial or empty manifest — that would blank every
    // catalogue. Same rule as the pricing sync.
    console.error(`✗ Could not read Drive: ${err.message}`);
    console.error('  Manifest left untouched.');
    process.exit(1);
  }

  const { manifest, warnings } = built;
  const previous = readManifest();
  const changes = diff(previous, manifest);

  console.log(`Resolved ${Object.keys(manifest.catalogues).length}/${CATALOGUE_SLOTS.length} catalogue slots from Drive.`);
  for (const [slot, v] of Object.entries(manifest.catalogues)) {
    console.log(`  ${slot.padEnd(11)} ${fmtMB(v.sizeBytes).padStart(9)}  ${v.name}`);
  }
  if (warnings.length) {
    console.log('\nWarnings:');
    warnings.forEach(w => console.log(`  ⚠️  ${w}`));
  }
  if (changes.length) {
    console.log('\nDrift vs committed manifest:');
    changes.forEach(c => console.log(`  ${c}`));
  } else {
    console.log('\nNo drift — committed manifest matches Drive.');
  }

  if (check) {
    if (changes.length) {
      console.error('\n✗ Manifest is stale. Run without --check and commit the result.');
      process.exit(1);
    }
    console.log('✓ Manifest is current.');
    return;
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n💾 Wrote ${path.relative(process.cwd(), MANIFEST)}`);
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}

module.exports = { build, diff, CATALOGUE_SLOTS };
