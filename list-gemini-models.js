require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const listModels = async () => {
  console.log('📋 Listing available Gemini models...\n');

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // List all models
    const models = await genAI.listModels();

    console.log('✅ Available models:');
    for await (const model of models) {
      if (model.supportedGenerationMethods.includes('generateContent')) {
        console.log(`  - ${model.name} (${model.description || 'No description'})`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
};

listModels();
