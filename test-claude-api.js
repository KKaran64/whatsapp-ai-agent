require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const testClaudeAPI = async () => {
  console.log('🧪 Testing Claude API...\n');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: 'Say "Hello! API is working!" in one sentence.'
      }]
    });

    console.log('✅ Claude API is working!');
    console.log('📝 Response:', response.content[0].text);
    console.log('\n💰 Your API key has sufficient credits!');
    console.log('🎉 Ready to process WhatsApp messages!\n');

    console.log('📊 Usage for this test:');
    console.log(`   Input tokens: ${response.usage.input_tokens}`);
    console.log(`   Output tokens: ${response.usage.output_tokens}`);
    console.log(`   Cost: ~$${((response.usage.input_tokens * 1 + response.usage.output_tokens * 5) / 1000000).toFixed(6)}\n`);

  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('❌ Authentication Error: Invalid API key');
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error('❌ Rate Limit: Too many requests');
    } else if (error instanceof Anthropic.APIError) {
      console.error(`❌ API Error (${error.status}):`, error.message);
      if (error.status === 400) {
        console.log('\n⚠️  ISSUE: Insufficient credits');
        console.log('👉 Go to: https://console.anthropic.com/settings/billing');
        console.log('👉 Add credits to continue\n');
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
};

testClaudeAPI();
