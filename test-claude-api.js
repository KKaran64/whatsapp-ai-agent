require('dotenv').config();
const axios = require('axios');

const testClaudeAPI = async () => {
  console.log('🧪 Testing Claude API...\n');

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: 'Say "Hello! API is working!" in one sentence.'
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    console.log('✅ Claude API is working!');
    console.log('📝 Response:', response.data.content[0].text);
    console.log('\n💰 Your API key has sufficient credits!');
    console.log('🎉 Ready to process WhatsApp messages!\n');

    // Show usage info
    console.log('📊 Usage for this test:');
    console.log(`   Input tokens: ${response.data.usage.input_tokens}`);
    console.log(`   Output tokens: ${response.data.usage.output_tokens}`);
    console.log(`   Cost: ~$${((response.data.usage.input_tokens * 3 + response.data.usage.output_tokens * 15) / 1000000).toFixed(6)}\n`);

  } catch (error) {
    if (error.response?.data) {
      console.error('❌ API Error:', error.response.data);

      if (error.response.data.error?.type === 'invalid_request_error') {
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
