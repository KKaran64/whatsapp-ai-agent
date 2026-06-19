jest.mock('../../rag/pinecone-client');
jest.mock('../../rag/embed');

const pineconeClient = require('../../rag/pinecone-client');
const embed = require('../../rag/embed');
const { retrieveContext } = require('../../rag/retriever');

describe('retriever', () => {
  let mockQuery;

  beforeEach(() => {
    mockQuery = jest.fn().mockResolvedValue({
      matches: [
        { id: 'v1', score: 0.9, metadata: { customerMessage: 'past', botResponse: 'response', outcome: 'sale' } }
      ]
    });
    pineconeClient.getIndex.mockReturnValue({ query: mockQuery });
    pineconeClient.isConfigured.mockReturnValue(true);
    embed.embedText.mockResolvedValue(new Array(768).fill(0.1));
  });

  test('retrieveContext returns empty when RAG disabled', async () => {
    pineconeClient.isConfigured.mockReturnValue(false);
    const result = await retrieveContext({ message: 'hi', customerPhone: '919' });
    expect(result.customerHistory).toEqual([]);
    expect(result.similarConversations).toEqual([]);
  });

  test('retrieveContext returns parallel results', async () => {
    const result = await retrieveContext({ message: 'need coasters', customerPhone: '919876543210' });
    expect(result.similarConversations).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalled();
  });

  test('retrieveContext applies filters for pricing queries', async () => {
    await retrieveContext({ message: 'how much for 100 coasters', customerPhone: '919' });
    const calls = mockQuery.mock.calls;
    const pricingCall = calls.find(c => c[0].filter?.isStaleForPricing !== undefined);
    expect(pricingCall).toBeDefined();
  });
});
