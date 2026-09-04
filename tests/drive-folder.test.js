// Parsing the Drive folder listing is what lets config be reconciled against
// the folder the business actually maintains, instead of against a snapshot
// somebody pinned once. The parser is pure so it can be tested without
// network; a synthetic payload in the same shape Drive emits is enough.

const { parseFolderHtml, pickNewest, unescapeJsString } = require('../lib/drive-folder');

// Build a page body in Drive's real shape: the listing is a JS string literal
// with \xNN escapes assigned to window['_DRIVE_ivd'].
function makePage(files) {
  const rows = files.map(f => {
    const row = new Array(20).fill(null);
    row[0] = f.id;
    row[2] = f.name;
    row[3] = f.mime || 'application/pdf';
    row[9] = f.modifiedMs || 0;
    row[13] = f.sizeBytes || 0;
    return row;
  });
  const json = JSON.stringify([rows]);
  const escaped = json
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\x22')
    .replace(/'/g, '\\x27');
  return `<html><script>window['_DRIVE_ivd'] = '${escaped}';</script></html>`;
}

describe('unescapeJsString', () => {
  test('decodes hex escapes', () => {
    expect(unescapeJsString('\\x22hello\\x22')).toBe('"hello"');
  });

  test('an escaped backslash is not re-interpreted', () => {
    // Single pass matters: a naive sequence of replaces turns \\x22 into a quote.
    expect(unescapeJsString('a\\\\x22b')).toBe('a\\x22b');
  });

  test('decodes escaped forward slashes', () => {
    expect(unescapeJsString('https:\\/\\/drive.google.com')).toBe('https://drive.google.com');
  });
});

describe('parseFolderHtml', () => {
  test('extracts id, name, mime, modified time and size', () => {
    const page = makePage([
      { id: 'abc123', name: 'CORK PRODUCT CATALOGUE 2026.pdf', modifiedMs: 1788000000000, sizeBytes: 36000000 }
    ]);
    const files = parseFolderHtml(page);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      id: 'abc123',
      name: 'CORK PRODUCT CATALOGUE 2026.pdf',
      mime: 'application/pdf',
      modifiedMs: 1788000000000,
      sizeBytes: 36000000
    });
  });

  test('handles names containing quotes and non-ascii', () => {
    const page = makePage([{ id: 'x1', name: 'CORK "PREMIUM" CATALOGUE – 2026.pdf' }]);
    expect(parseFolderHtml(page)[0].name).toBe('CORK "PREMIUM" CATALOGUE – 2026.pdf');
  });

  test('THROWS when the listing is absent — never returns an empty list', () => {
    // A private folder or a Drive format change must not look like
    // "the folder is empty", which would silently blank every catalogue.
    expect(() => parseFolderHtml('<html>no listing here</html>')).toThrow(/not found/i);
  });

  test('throws when the payload is not valid JSON', () => {
    expect(() => parseFolderHtml("<script>window['_DRIVE_ivd'] = '\\x7bnope';</script>"))
      .toThrow(/could not be parsed|unexpected shape/i);
  });

  test('skips malformed rows rather than crashing', () => {
    const page = makePage([{ id: 'ok1', name: 'GOOD.pdf' }]);
    const broken = page.replace('[[', '[[null,');
    expect(() => parseFolderHtml(broken)).not.toThrow();
  });
});

describe('pickNewest', () => {
  const files = [
    { id: 'old', name: 'CORK YOGA WELLNESS PRODUCT CATALOGUE 2026 (5).pdf', modifiedMs: 1000 },
    { id: 'new', name: 'CORK YOGA WELLNESS PRODUCT CATALOGUE 2026 (2).pdf', modifiedMs: 2000 },
    { id: 'other', name: 'CORK TROPHY CATALOGUE 2026.pdf', modifiedMs: 3000 }
  ];

  test('prefers the most recently modified match, not the name order', () => {
    // The real case: "(2)" replaced "(5)". Name order is meaningless here —
    // only modified time identifies the current file.
    expect(pickNewest(files, /yoga|wellness/i).id).toBe('new');
  });

  test('returns null when nothing matches', () => {
    expect(pickNewest(files, /nonexistent/i)).toBeNull();
  });

  test('does not mutate the input array', () => {
    const before = files.map(f => f.id);
    pickNewest(files, /yoga/i);
    expect(files.map(f => f.id)).toEqual(before);
  });
});
