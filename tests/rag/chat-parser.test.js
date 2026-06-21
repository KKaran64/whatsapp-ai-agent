const { parseChat, extractQAPairs } = require('../../rag/chat-parser');

const SAMPLE = `[14/03/2026, 11:23:45 AM] Karan: hi
[14/03/2026, 11:24:02 AM] You: Hi! How many pieces are you looking for?
[14/03/2026, 11:24:30 AM] Karan: 100 coasters
[14/03/2026, 11:25:00 AM] You: Great! What's the budget per piece?`;

describe('chat-parser', () => {
  test('parseChat extracts messages with timestamps', () => {
    const messages = parseChat(SAMPLE, 'You');
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ role: 'customer', content: 'hi' });
    expect(messages[1]).toMatchObject({ role: 'business', content: 'Hi! How many pieces are you looking for?' });
  });

  test('parseChat handles 24-hour format', () => {
    const sample = `[14/03/2026, 23:45] Karan: hi\n[14/03/2026, 23:46] You: hello`;
    const messages = parseChat(sample, 'You');
    expect(messages).toHaveLength(2);
  });

  test('parseChat returns empty for invalid input', () => {
    expect(parseChat('', 'You')).toEqual([]);
    expect(parseChat(null, 'You')).toEqual([]);
  });

  test('extractQAPairs groups customer→business exchanges', () => {
    const messages = parseChat(SAMPLE, 'You');
    const pairs = extractQAPairs(messages);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({
      customerMessage: 'hi',
      botResponse: 'Hi! How many pieces are you looking for?'
    });
  });

  test('extractQAPairs handles consecutive customer messages', () => {
    const sample = `[14/03/2026, 11:00 AM] Karan: hi
[14/03/2026, 11:01 AM] Karan: are you there
[14/03/2026, 11:02 AM] You: yes hello`;
    const messages = parseChat(sample, 'You');
    const pairs = extractQAPairs(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].customerMessage).toContain('hi');
    expect(pairs[0].customerMessage).toContain('are you there');
  });
});
