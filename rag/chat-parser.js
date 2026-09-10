// Parses WhatsApp exported .txt chat into structured messages.
// WhatsApp format: [DD/MM/YYYY, HH:MM AM/PM] Name: message
// "You" / your business number is the bot side; everything else is customer.
//
// Real exports are not clean ASCII. WhatsApp writes a U+200E LEFT-TO-RIGHT
// MARK before the opening bracket and a U+202F NARROW NO-BREAK SPACE before
// AM/PM, and ships CRLF line endings. The original anchor (^\[) therefore
// failed on almost every line, which were then swallowed as continuations of
// the previous message: 326 of 9,268 messages parsed across data/past-chats,
// and zero business replies, because the very first line of each file also
// failed and left `current` null.
//
// That matters beyond parsing — scripts/import-chats.js builds the RAG index
// through this function, so retrieval was trained on a 3.5% sample.

// Bidirectional/invisible marks WhatsApp sprinkles through exports.
const INVISIBLE = /[\u200e\u200f\u202a-\u202e\ufeff]/g;

const MESSAGE_REGEX = /^\s*\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\]\s+([^:]+):\s*(.*)$/i;

function parseChat(text, businessName = 'You') {
  if (!text || typeof text !== 'string') return [];

  // Strip invisible marks and CR before matching, so the anchors see the
  // structure the format actually has.
  const lines = text.replace(INVISIBLE, '').split('\n').map(l => l.replace(/\r$/, ''));
  const messages = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(MESSAGE_REGEX);
    if (match) {
      if (current) messages.push(current);
      const [, dateStr, timeStr, sender, content] = match;
      current = {
        timestamp: parseTimestamp(dateStr, timeStr),
        sender: sender.trim(),
        role: sender.trim().toLowerCase() === businessName.toLowerCase() ? 'business' : 'customer',
        content: content.trim()
      };
    } else if (current && line.trim()) {
      current.content += '\n' + line.trim();
    }
  }
  if (current) messages.push(current);

  return messages;
}

function parseTimestamp(dateStr, timeStr) {
  const [d, m, y] = dateStr.split('/');
  const year = y.length === 2 ? `20${y}` : y;
  const isoDate = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  try {
    return new Date(`${isoDate} ${timeStr}`).getTime();
  } catch {
    return Date.now();
  }
}

function extractQAPairs(messages) {
  const pairs = [];
  let pendingCustomer = [];

  for (const msg of messages) {
    if (msg.role === 'customer') {
      pendingCustomer.push(msg.content);
    } else if (msg.role === 'business' && pendingCustomer.length > 0) {
      pairs.push({
        customerMessage: pendingCustomer.join(' | '),
        botResponse: msg.content,
        timestamp: msg.timestamp
      });
      pendingCustomer = [];
    }
  }

  return pairs;
}

module.exports = { parseChat, extractQAPairs };
