require('dotenv').config();
const axios = require('axios');

const testGemini = async () => {
  console.log('🧪 Testing Gemini API directly...\n');

  const apiKey = process.env.GEMINI_API_KEY;
  console.log('API Key:', apiKey.substring(0, 20) + '...\n');

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [{
            text: 'Say "Hello! API is working!" in one sentence.'
          }]
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Gemini API is working!');
    console.log('📝 Response:', response.data.candidates[0].content.parts[0].text);
    console.log('\n🎉 FREE Gemini API is ready!');
    console.log('🚀 Ready to process WhatsApp messages!\n');

  } catch (error) {
    console.error('❌ API Error Status:', error.response?.status);
    console.error('❌ API Error:', error.response?.data || error.message);

    if (error.response?.status === 403 || error.response?.status === 400) {
      console.log('\n⚠️  Possible issues:');
      console.log('1. API key might not have Gemini API enabled');
      console.log('2. Go to: https://makersuite.google.com/app/apikey');
      console.log('3. Check if API is enabled in Google Cloud Console');
      console.log('4. Try regenerating the API key\n');
    }
  }
};

testGemini();
