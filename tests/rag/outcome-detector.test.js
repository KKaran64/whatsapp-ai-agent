const { detectOutcome } = require('../../rag/outcome-detector');

describe('outcome-detector', () => {
  test('detects sale on payment confirmation', () => {
    const messages = [
      { role: 'customer', content: 'paid', timestamp: Date.now() },
      { role: 'agent', content: 'Total ₹8200', timestamp: Date.now() - 60000 }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('sale');
    expect(result.saleAmount).toBeGreaterThan(0);
  });

  test('detects no_sale on rejection', () => {
    const messages = [
      { role: 'customer', content: 'too expensive, sorry', timestamp: Date.now() }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('no_sale');
  });

  test('detects abandoned on long silence', () => {
    const messages = [
      { role: 'customer', content: 'how much', timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000 },
      { role: 'agent', content: '₹8200', timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000 }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('abandoned');
  });

  test('returns in_progress for recent active chat', () => {
    const messages = [
      { role: 'customer', content: 'hi', timestamp: Date.now() - 60000 },
      { role: 'agent', content: 'hello', timestamp: Date.now() - 30000 },
      { role: 'customer', content: 'I want coasters', timestamp: Date.now() - 10000 }
    ];
    const result = detectOutcome(messages);
    expect(result.outcome).toBe('in_progress');
  });
});
