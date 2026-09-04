// A customer asked for the wall-tiles catalogue, then the yoga catalogue, and
// got nothing both times. Every PDF_CATALOG_* value that was set pointed at a
// deleted Drive file (404 on the exact URL WhatsApp fetches), and six of the
// nine slots the routing code supports had never been set in any environment.
//
// Nothing failed loudly — sendWhatsAppDocument was simply never reached, or
// was handed a dead link. These tests make that class of failure visible in
// CI instead of in a customer conversation.

const { CATALOGUES, FILE_IDS, resolve } = require('../config/catalogues');

// Every slot the routing chain in server.js can select.
const ROUTED_SLOTS = [
  'PRODUCTS', 'HORECA', 'COMBOS', 'TROPHY',
  'PLANTERS', 'YOGA', 'ELEVATION', 'MINIMALIST'
];

describe('every routed catalogue slot is configured', () => {
  test.each(ROUTED_SLOTS)('%s resolves to a URL', (slot) => {
    expect(CATALOGUES[slot]).toBeTruthy();
    expect(CATALOGUES[slot]).toMatch(/^https:\/\//);
  });

  test('no slot is left empty — an empty slot silently sends no catalogue', () => {
    const empty = Object.entries(CATALOGUES).filter(([, v]) => !v).map(([k]) => k);
    expect(empty).toEqual([]);
  });
});

describe('file ids are distinct and well formed', () => {
  test('no two slots point at the same file', () => {
    const ids = Object.values(FILE_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('ids look like Drive file ids', () => {
    for (const [slot, id] of Object.entries(FILE_IDS)) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{25,50}$/);
    }
  });

  test('none of the dead 2026-09 ids are still referenced', () => {
    // The three that were live in the environment and returned 404.
    const DEAD = [
      '1mPpm39-fvrD5xiBgOaNJMEieAuhlL8qv',
      '1pSt59YQhgdCu-vc3n48-I_tQAA7DTLaY',
      '1SrOCT_BFJNqIbyCANEwaoGT-kIhVnW7j'
    ];
    for (const id of Object.values(FILE_IDS)) {
      expect(DEAD).not.toContain(id);
    }
  });
});

describe('env override still wins', () => {
  test('PDF_CATALOG_<SLOT> overrides the versioned default', () => {
    const prev = process.env.PDF_CATALOG_HORECA;
    process.env.PDF_CATALOG_HORECA = 'https://example.com/override.pdf';
    try {
      expect(resolve('HORECA')).toBe('https://example.com/override.pdf');
    } finally {
      if (prev === undefined) delete process.env.PDF_CATALOG_HORECA;
      else process.env.PDF_CATALOG_HORECA = prev;
    }
  });

  test('an empty env var falls back to the default rather than blanking the slot', () => {
    // This is the shape the outage had: the var existed but was useless.
    const prev = process.env.PDF_CATALOG_YOGA;
    process.env.PDF_CATALOG_YOGA = '   ';
    try {
      expect(resolve('YOGA')).toMatch(/^https:\/\/drive\.google\.com/);
    } finally {
      if (prev === undefined) delete process.env.PDF_CATALOG_YOGA;
      else process.env.PDF_CATALOG_YOGA = prev;
    }
  });
});

describe('the URL form is the one WhatsApp can fetch', () => {
  test('uses uc?export=download, not a /file/d/ viewer link', () => {
    // Meta fetches document.link server-side; a viewer link returns an HTML
    // page rather than PDF bytes.
    for (const url of Object.values(CATALOGUES)) {
      expect(url).toContain('uc?export=download&id=');
      expect(url).not.toContain('/file/d/');
    }
  });
});
