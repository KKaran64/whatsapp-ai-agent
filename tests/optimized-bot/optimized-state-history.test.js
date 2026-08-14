process.env.MONGODB_ENCRYPTION_KEY = process.env.MONGODB_ENCRYPTION_KEY || 'a'.repeat(64);

const OptimizedState = require('../../models/OptimizedState');

describe('OptimizedState conversation_history cap', () => {
  test('schema validator allows up to 50 messages', () => {
    const doc = new OptimizedState({ customer_phone: '919999999999' });
    for (let i = 0; i < 50; i++) {
      doc.conversation_history.push({ role: 'user', content: `msg ${i}` });
    }
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  test('schema validator rejects 51 messages', () => {
    const doc = new OptimizedState({ customer_phone: '919999999998' });
    for (let i = 0; i < 51; i++) {
      doc.conversation_history.push({ role: 'user', content: `msg ${i}` });
    }
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors['conversation_history'].message).toMatch(/50/);
  });

  test('addMessage instance method keeps only the last 50', () => {
    const doc = new OptimizedState({ customer_phone: '919999999997' });
    for (let i = 0; i < 55; i++) {
      doc.addMessage('user', `msg ${i}`);
    }
    expect(doc.conversation_history.length).toBe(50);
    expect(doc.conversation_history[0].content).toBe('msg 5');
    expect(doc.conversation_history[49].content).toBe('msg 54');
  });
});
