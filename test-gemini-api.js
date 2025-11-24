require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const testGeminiAPI = async () => {
  console.log('🧪 Testing Gemini API...\n');

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

    const result = await model.generateContent('Say "Hello! Gemini API is working!" in one sentence.');
    const response = result.response.text();

    console.log('✅ Gemini API is working!');
    console.log('📝 Response:', response);
    console.log('\n🎉 FREE Gemini API is ready!');
    console.log('💰 No credits needed - completely FREE!');
    console.log('🚀 Ready to process WhatsApp messages!\n');

  } catch (error) {
    console.error('❌ API Error:', error.message);
    if (error.message.includes('API key')) {
      console.log('\n⚠️  ISSUE: Invalid API key');
      console.log('👉 Check your GEMINI_API_KEY in .env file\n');
    }
  }
};

testGeminiAPI();
