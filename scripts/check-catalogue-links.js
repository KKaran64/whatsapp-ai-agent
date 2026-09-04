#!/usr/bin/env node
// Fetch every catalogue link the bot can send and report what actually comes
// back. Exits non-zero if any slot is dead.
//
//   node scripts/check-catalogue-links.js
//
// The unit tests deliberately cannot do this — they must stay offline and
// fast. That gap is exactly how three dead catalogue links survived for
// months: the config was well-formed, so everything looked fine, and the only
// signal was a customer receiving nothing. This is the liveness half.
//
// Checks per slot:
//   - HTTP 200 on the same uc?export=download URL WhatsApp fetches
//   - the body is really a PDF (a deleted/private file returns an HTML page
//     with a 200 in some cases, which would be sent as a broken document)
//   - size under WhatsApp's 100 MB document ceiling

const https = require('https');
const { CATALOGUES } = require('../config/catalogues');

const WHATSAPP_DOC_LIMIT = 100 * 1024 * 1024;
const PDF_MAGIC = '%PDF-';

function head(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        return resolve(head(res.headers.location, hops + 1));
      }
      let first = Buffer.alloc(0);
      let total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (first.length < 8) first = Buffer.concat([first, chunk]).slice(0, 8);
        // Reading the whole 89 MB catalogue to check a magic number is waste;
        // stop once size is known to exceed the limit.
        if (total > WHATSAPP_DOC_LIMIT) res.destroy();
      });
      res.on('close', () => resolve({ status: res.statusCode, magic: first.toString('latin1'), bytes: total }));
      res.on('end', () => resolve({ status: res.statusCode, magic: first.toString('latin1'), bytes: total }));
    }).on('error', reject);
  });
}

async function main() {
  const slots = Object.keys(CATALOGUES).sort();
  let failures = 0;

  console.log(`Checking ${slots.length} catalogue links...\n`);
  for (const slot of slots) {
    const url = CATALOGUES[slot];
    let verdict, detail;
    try {
      const r = await head(url);
      const mb = (r.bytes / 1048576).toFixed(1) + ' MB';
      if (r.status !== 200) { verdict = 'DEAD'; detail = `HTTP ${r.status}`; }
      else if (!r.magic.startsWith(PDF_MAGIC)) { verdict = 'DEAD'; detail = `not a PDF (got "${r.magic.trim().slice(0, 12)}")`; }
      else if (r.bytes > WHATSAPP_DOC_LIMIT) { verdict = 'TOO BIG'; detail = `${mb} exceeds WhatsApp's 100 MB limit`; }
      else { verdict = 'OK'; detail = mb; }
    } catch (err) {
      verdict = 'DEAD';
      detail = err.message;
    }
    if (verdict !== 'OK') failures++;
    console.log(`  ${verdict.padEnd(8)} ${slot.padEnd(11)} ${detail}`);
  }

  if (failures) {
    console.error(`\n✗ ${failures} catalogue link(s) would fail to send.`);
    process.exit(1);
  }
  console.log('\n✓ All catalogue links are live and sendable.');
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
