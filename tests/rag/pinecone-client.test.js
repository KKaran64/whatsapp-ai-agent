const { getIndex, isConfigured } = require('../../rag/pinecone-client');

describe('pinecone-client', () => {
  test('isConfigured returns false when PINECONE_API_KEY missing', () => {
    const original = process.env.PINECONE_API_KEY;
    delete process.env.PINECONE_API_KEY;
    expect(isConfigured()).toBe(false);
    process.env.PINECONE_API_KEY = original;
  });

  test('isConfigured returns true when only PINECONE_API_KEY set (INDEX optional)', () => {
    process.env.PINECONE_API_KEY = 'test-key';
    delete process.env.PINECONE_INDEX;
    expect(isConfigured()).toBe(true);
  });

  test('isConfigured returns true when both PINECONE vars set', () => {
    process.env.PINECONE_API_KEY = 'test-key';
    process.env.PINECONE_INDEX = 'test-index';
    expect(isConfigured()).toBe(true);
  });

  test('getIndex throws if PINECONE_API_KEY missing', () => {
    const original = process.env.PINECONE_API_KEY;
    delete process.env.PINECONE_API_KEY;
    expect(() => getIndex()).toThrow('PINECONE_API_KEY not set');
    process.env.PINECONE_API_KEY = original;
  });
});
