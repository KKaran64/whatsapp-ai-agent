const embed = require('../../rag/embed');

jest.mock('axios');
const axios = require('axios');

describe('embed', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    axios.post.mockReset();
  });

  test('embedText returns 768-dim vector on success', async () => {
    const fakeVector = new Array(768).fill(0.1);
    axios.post.mockResolvedValue({ data: { embedding: { values: fakeVector } } });
    const result = await embed.embedText('hello cork coasters');
    expect(result).toHaveLength(768);
    expect(result[0]).toBe(0.1);
  });

  test('embedText returns null on API error', async () => {
    axios.post.mockRejectedValue(new Error('API down'));
    const result = await embed.embedText('hello');
    expect(result).toBeNull();
  });

  test('embedText returns null on empty input', async () => {
    const result = await embed.embedText('');
    expect(result).toBeNull();
  });

  test('embedBatch processes array sequentially', async () => {
    const fakeVector = new Array(768).fill(0.5);
    axios.post.mockResolvedValue({ data: { embedding: { values: fakeVector } } });
    const result = await embed.embedBatch(['a', 'b', 'c']);
    expect(result).toHaveLength(3);
    expect(axios.post).toHaveBeenCalledTimes(3);
  });
});
