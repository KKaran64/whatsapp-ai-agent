jest.mock('../../rag/pinecone-client');
jest.mock('../../rag/embed');

const pineconeClient = require('../../rag/pinecone-client');
const embed = require('../../rag/embed');
const { indexQAPair, indexConversation } = require('../../rag/indexer');

describe('indexer', () => {
  let mockUpsert;

  beforeEach(() => {
    mockUpsert = jest.fn().mockResolvedValue({});
    pineconeClient.getIndex.mockReturnValue({ upsert: mockUpsert });
    pineconeClient.isConfigured.mockReturnValue(true);
    embed.embedText.mockResolvedValue(new Array(768).fill(0.1));
  });

  test('indexQAPair upserts vector with metadata', async () => {
    const result = await indexQAPair({
      customerPhone: '919876543210',
      customerMessage: 'need coasters',
      botResponse: 'how many?',
      timestamp: 1719945600,
      outcome: 'sale',
      products: ['coasters']
    });
    expect(result.success).toBe(true);
    expect(mockUpsert).toHaveBeenCalled();
    const upserted = mockUpsert.mock.calls[0][0];
    expect(upserted[0].metadata.outcome).toBe('sale');
    expect(upserted[0].values).toHaveLength(768);
  });

  test('indexQAPair skips if Pinecone not configured', async () => {
    pineconeClient.isConfigured.mockReturnValue(false);
    const result = await indexQAPair({ customerMessage: 'hi' });
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test('indexQAPair returns failure if embedding fails', async () => {
    embed.embedText.mockResolvedValue(null);
    const result = await indexQAPair({ customerMessage: 'hi' });
    expect(result.success).toBe(false);
  });

  test('indexConversation processes multiple QA pairs', async () => {
    const result = await indexConversation({
      customerPhone: '919876543210',
      qaPairs: [
        { customerMessage: 'hi', botResponse: 'hello', timestamp: 1 },
        { customerMessage: 'coasters?', botResponse: 'yes', timestamp: 2 }
      ],
      outcome: 'sale'
    });
    expect(result.indexed).toBe(2);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });
});
