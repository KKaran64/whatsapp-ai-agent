// The parser dropped 96.5% of every real WhatsApp export: 326 of 9,268
// messages across data/past-chats.
//
// Cause: WhatsApp prefixes exported lines with U+200E (LEFT-TO-RIGHT MARK) and
// separates the time from AM/PM with U+202F (NARROW NO-BREAK SPACE). The LRM
// sits before the opening bracket, so the ^\[ anchor never matches and the
// line is treated as a continuation of the previous message.
//
// The existing suite passes because its fixture is hand-typed clean ASCII —
// text that no real export produces. That is the actual lesson here: a fixture
// invented by the author tests the author's mental model, not the data. The
// fixtures below are byte-for-byte real, including the invisible characters.
//
// Consequence: scripts/import-chats.js feeds the RAG index through this
// parser, so the retrieval corpus was built from a 3.5% sample.

const { parseChat, extractQAPairs } = require('../../rag/chat-parser');

const BUSINESS = '9 Cork Sustainable Products';

// U+200E before '[', U+202F before 'PM' — exactly as WhatsApp writes them.
const LRM = '‎';
const NNBSP = ' ';
const REAL_EXPORT =
  `${LRM}[24/12/24, 4:52:36${NNBSP}PM] Vidya Tapwell: Is this available\n` +
  `${LRM}[24/12/24, 4:53:01${NNBSP}PM] ${BUSINESS}: Yes, we have it in stock.\n` +
  `${LRM}[24/12/24, 4:53:40${NNBSP}PM] Vidya Tapwell: What is the price for 100 pcs\n` +
  `${LRM}[24/12/24, 4:54:10${NNBSP}PM] ${BUSINESS}: For 100 pcs it is Rs45 per piece.\n`;

describe('real WhatsApp export format', () => {
  test('parses lines carrying the U+200E prefix', () => {
    const msgs = parseChat(REAL_EXPORT, BUSINESS);
    expect(msgs).toHaveLength(4);
  });

  test('assigns roles correctly, so business replies are not lost', () => {
    const msgs = parseChat(REAL_EXPORT, BUSINESS);
    expect(msgs.filter(m => m.role === 'customer')).toHaveLength(2);
    expect(msgs.filter(m => m.role === 'business')).toHaveLength(2);
  });

  test('the invisible characters do not leak into message content', () => {
    const msgs = parseChat(REAL_EXPORT, BUSINESS);
    for (const m of msgs) {
      expect(m.content).not.toMatch(/[‎‏ ]/);
    }
    expect(msgs[0].content).toBe('Is this available');
  });

  test('handles the U+202F before AM/PM', () => {
    const msgs = parseChat(`${LRM}[01/02/25, 9:05:00${NNBSP}AM] Someone: morning\n`, BUSINESS);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('morning');
  });

  test('CRLF line endings do not corrupt the last field', () => {
    const crlf = REAL_EXPORT.split('\n').join('\r\n');
    const msgs = parseChat(crlf, BUSINESS);
    expect(msgs[0].content).toBe('Is this available');
  });

  test('Q&A extraction works once both roles survive', () => {
    // extractQAPairs needs business replies; with roles broken it produced none.
    const pairs = extractQAPairs(parseChat(REAL_EXPORT, BUSINESS));
    expect(pairs.length).toBeGreaterThan(0);
  });
});

describe('previously-supported formats still parse', () => {
  test('clean ASCII export without invisible characters', () => {
    const clean =
      `[14/03/2026, 11:23:45 AM] Karan: hi\n` +
      `[14/03/2026, 11:24:02 AM] You: Hi! How many pieces?\n`;
    expect(parseChat(clean, 'You')).toHaveLength(2);
  });

  test('24-hour timestamps', () => {
    expect(parseChat(`[14/03/2026, 23:05] Karan: late\n`, 'You')).toHaveLength(1);
  });

  test('invalid input still returns an empty array', () => {
    expect(parseChat('', 'You')).toEqual([]);
    expect(parseChat(null, 'You')).toEqual([]);
  });
});

describe('the whole shipped corpus parses', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'data', 'past-chats');
  // The directory itself is always present (data/past-chats/.gitkeep is
  // tracked) but the exports are gitignored, so "dir exists" proves nothing.
  // Gate on the files, and skip visibly rather than pass vacuously.
  const corpus = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(x => x.endsWith('.txt'))
    : [];
  const testWithCorpus = corpus.length ? test : test.skip;

  testWithCorpus('data/past-chats yields thousands of messages, not hundreds', () => {
    let total = 0;
    let business = 0;
    for (const f of corpus) {
      const msgs = parseChat(fs.readFileSync(path.join(dir, f), 'utf8'), BUSINESS);
      total += msgs.length;
      business += msgs.filter(m => m.role === 'business').length;
    }
    // Was 326 total / 0 business before the fix.
    expect(total).toBeGreaterThan(5000);
    expect(business).toBeGreaterThan(1000);
  });
});
