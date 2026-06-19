const { buildRagContext, estimateTokens } = require('../../rag/context-builder');

describe('context-builder', () => {
  const sampleContext = {
    customerHistory: [
      { customerMessage: 'past coasters', botResponse: 'past response', outcome: 'sale', saleAmount: 5000 }
    ],
    similarConversations: [
      { customerMessage: 'similar 1', botResponse: 'reply 1', outcome: 'sale', products: ['coasters'], saleAmount: 6000 },
      { customerMessage: 'similar 2', botResponse: 'reply 2', outcome: 'sale', products: ['coasters'], saleAmount: 8000 }
    ],
    productContext: [
      { customerMessage: 'product ref', botResponse: 'product reply', products: ['planters'] }
    ],
    usedRAG: true
  };

  test('returns empty string when no RAG data', () => {
    const result = buildRagContext({
      customerHistory: [], similarConversations: [], productContext: [], usedRAG: false
    });
    expect(result).toBe('');
  });

  test('includes section headers', () => {
    const result = buildRagContext(sampleContext);
    expect(result).toContain('THIS CUSTOMER');
    expect(result).toContain('SIMILAR SUCCESSFUL');
  });

  test('respects max token budget', () => {
    const big = {
      customerHistory: [],
      similarConversations: new Array(50).fill({ customerMessage: 'x'.repeat(1000), botResponse: 'y'.repeat(1000), outcome: 'sale' }),
      productContext: [],
      usedRAG: true
    };
    const result = buildRagContext(big, { maxTokens: 1000 });
    expect(estimateTokens(result)).toBeLessThanOrEqual(1100);
  });

  test('estimateTokens approximates char count', () => {
    const tokens = estimateTokens('hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });
});
