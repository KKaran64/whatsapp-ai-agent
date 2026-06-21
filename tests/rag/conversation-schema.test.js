process.env.MONGODB_ENCRYPTION_KEY = process.env.MONGODB_ENCRYPTION_KEY || 'a'.repeat(64);
const Conversation = require('../../models/Conversation');

describe('Conversation RAG fields', () => {
  test('schema has outcome enum field', () => {
    const path = Conversation.schema.path('outcome');
    expect(path).toBeDefined();
    expect(path.enumValues).toEqual(['in_progress', 'sale', 'no_sale', 'abandoned']);
  });

  test('schema has embedded boolean field', () => {
    const path = Conversation.schema.path('embedded');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
  });

  test('schema has embeddingIds array', () => {
    const path = Conversation.schema.path('embeddingIds');
    expect(path).toBeDefined();
  });

  test('schema has outcomeAmount number', () => {
    const path = Conversation.schema.path('outcomeAmount');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Number');
  });
});
