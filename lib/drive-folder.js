// Read a public Google Drive folder listing without credentials.
//
// Why this exists: catalogue and sheet ids were pinned in code and in env
// vars, so every time a file was replaced in Drive the config silently went
// stale. The folder is the thing the business actually maintains — this makes
// it readable, so the code can be reconciled against reality instead of
// against a snapshot somebody took once.
//
// Drive embeds the folder listing in the page as a JS string assigned to
// window['_DRIVE_ivd']. It is an internal format with no stability guarantee,
// which is exactly why parsing is isolated here behind a narrow contract and
// why the manifest it produces is committed: if Google changes the format,
// the refresh script fails loudly and the committed manifest keeps working.

const https = require('https');

// Positions used from each file entry. Verified against a live folder.
const F_ID = 0;
const F_NAME = 2;
const F_MIME = 3;
const F_MODIFIED_MS = 9;
const F_SIZE_BYTES = 13;

// Decode a JS string literal body (\x22, é, \/, \\) into real text.
// Single pass so an escaped backslash cannot be re-interpreted.
function unescapeJsString(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, esc) => {
    if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return esc; // covers \\ \/ \' \"
    }
  });
}

/**
 * Extract the file listing from a Drive folder page.
 * @returns {Array<{id,name,mime,modifiedMs,sizeBytes}>}
 * @throws when the embedded listing is absent or unparseable — callers must
 *         treat that as "could not read Drive", never as "folder is empty".
 */
function parseFolderHtml(html) {
  const m = /_DRIVE_ivd'\]\s*=\s*'([^']+)'/.exec(String(html || ''));
  if (!m) throw new Error('Drive listing not found (folder private, or Drive changed its page format)');

  let data;
  try {
    data = JSON.parse(unescapeJsString(m[1]));
  } catch (e) {
    throw new Error(`Drive listing could not be parsed: ${e.message}`);
  }
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Drive listing had an unexpected shape');
  }

  return data[0]
    .filter(row => Array.isArray(row) && typeof row[F_ID] === 'string' && typeof row[F_NAME] === 'string')
    .map(row => ({
      id: row[F_ID],
      name: row[F_NAME],
      mime: row[F_MIME] || '',
      modifiedMs: Number(row[F_MODIFIED_MS]) || 0,
      sizeBytes: Number(row[F_SIZE_BYTES]) || 0
    }));
}

function fetchUrl(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, hops + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', d => (body += d));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function listFolder(folderId) {
  const html = await fetchUrl(`https://drive.google.com/drive/folders/${folderId}`);
  return parseFolderHtml(html);
}

/**
 * Pick the file matching `pattern`, preferring the most recently modified.
 *
 * Newest-wins matters: catalogues are re-uploaded as "... (2).pdf",
 * "... (5).pdf" rather than replaced in place, so name order is meaningless
 * and only the modified time identifies the current one.
 */
function pickNewest(files, pattern) {
  const matches = files.filter(f => pattern.test(f.name));
  if (matches.length === 0) return null;
  return matches.slice().sort((a, b) => b.modifiedMs - a.modifiedMs)[0];
}

module.exports = { parseFolderHtml, listFolder, pickNewest, unescapeJsString };
