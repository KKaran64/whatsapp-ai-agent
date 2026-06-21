// Parses WhatsApp exported .txt chat into structured messages.
// WhatsApp format: [DD/MM/YYYY, HH:MM AM/PM] Name: message
// "You" / your business number is the bot side; everything else is customer.

const MESSAGE_REGEX = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\]\s+([^:]+):\s*(.*)$/i;

function parseChat(text, businessName = 'You') {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split('\n');
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
