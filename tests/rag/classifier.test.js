jest.mock('groq-sdk');
const Groq = require('groq-sdk');
const { classifyConversation } = require('../../rag/classifier');

describe('classifier', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test';
    Groq.mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  outcome: 'sale',
                  saleAmount: 8200,
                  products: ['coasters'],
                  customerType: 'corporate',
                  budget: 50,
                  confidence: 0.9
                })
              }
            }]
          })
        }
      }
    }));
  });

  test('classifyConversation returns structured outcome', async () => {
    const messages = [
      { role: 'customer', content: 'Need 100 coasters' },
      { role: 'business', content: 'For corporate gifting?' },
      { role: 'customer', content: 'yes, paid' }
    ];
    const result = await classifyConversation(messages);
    expect(result.outcome).toBe('sale');
    expect(result.saleAmount).toBe(8200);
    expect(result.products).toContain('coasters');
  });

  test('classifyConversation marks low confidence as needsReview', async () => {
    Groq.mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ outcome: 'sale', confidence: 0.3 }) } }]
          })
        }
      }
    }));
    const result = await classifyConversation([{ role: 'customer', content: 'hi' }]);
    expect(result.needsReview).toBe(true);
  });

  test('returns default on Groq failure', async () => {
    Groq.mockImplementation(() => ({
      chat: { completions: { create: jest.fn().mockRejectedValue(new Error('down')) } }
    }));
    const result = await classifyConversation([{ role: 'customer', content: 'hi' }]);
    expect(result.outcome).toBe('in_progress');
    expect(result.needsReview).toBe(true);
  });
});
