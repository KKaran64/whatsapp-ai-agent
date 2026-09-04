// Wall panels are a distinct line from the Elevation and Minimalist wall
// COVERING ranges, and they have their own "3d e catalogue.pdf". Before this,
// "wall panel" matched the ELEVATION pattern, so the bot confidently sent the
// wrong catalogue.
//
// That catalogue is also 247 MB, which breaks document delivery two ways:
//   - WhatsApp rejects documents over 100 MB.
//   - Past Drive's virus-scan threshold, uc?export=download returns an HTML
//     interstitial rather than the file, so Meta would fetch a web page and
//     send a broken document. Verified live: content-type text/html.
// So an oversized catalogue must be delivered as a link, not as a file.

const { selectCatalogue, isOversized, viewUrl } = require('../config/catalogues');

describe('wall panels route to their own catalogue', () => {
  test.each([
    'do you have a catalogue for wall panels',
    'send me the 3d catalogue',
    'wall panel catalogue please'
  ])('%s -> WALL_PANELS', (msg) => {
    expect(selectCatalogue(msg)?.slot).toBe('WALL_PANELS');
  });

  test('wall coverings still route to Elevation, not to wall panels', () => {
    expect(selectCatalogue('wall covering catalogue')?.slot).toBe('ELEVATION');
  });

  test('wall tiles still route to a wall-covering catalogue', () => {
    expect(['ELEVATION', 'MINIMALIST'])
      .toContain(selectCatalogue('Can I get catalogue for wall tiles')?.slot);
  });
});

describe('oversized catalogues are flagged for link delivery', () => {
  test('the 247 MB wall panel catalogue is marked oversized', () => {
    const r = selectCatalogue('wall panel catalogue');
    expect(r.oversized).toBe(true);
    expect(r.viewUrl).toMatch(/^https:\/\/drive\.google\.com\/file\/d\/.+\/view/);
  });

  test('catalogues under the limit are not marked oversized', () => {
    for (const msg of ['trophy catalogue', 'combo catalogue', 'yoga catalogue']) {
      expect(selectCatalogue(msg).oversized).toBe(false);
    }
  });

  test('isOversized reads the manifest size, not a guess', () => {
    expect(isOversized('WALL_PANELS')).toBe(true);
    expect(isOversized('COMBOS')).toBe(false);
    // Unknown slots must not be treated as oversized — that would suppress
    // document delivery for a catalogue we simply have no size for.
    expect(isOversized('NOT_A_SLOT')).toBe(false);
  });

  test('viewUrl is a human-clickable link, not the download url', () => {
    // The download URL returns Drive's virus-scan interstitial for large
    // files; the view link renders that page correctly for a human, who can
    // then choose to download.
    const u = viewUrl('WALL_PANELS');
    expect(u).toContain('/view');
    expect(u).not.toContain('uc?export=download');
  });
});
