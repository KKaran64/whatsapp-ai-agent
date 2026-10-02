// Quick test of Groq and Gemini API keys
require('dotenv').config();
const Groq = require('groq-sdk');
const axios = require('axios');
const { MODELS } = require('./config/models');

async function testGroq() {
  console.log('\n🔵 Testing Groq API...');
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: 'Say "Groq works!"' }],
      model: MODELS.GROQ_CHAT,
      max_tokens: 10
    });
    console.log('✅ Groq Response:', completion.choices[0].message.content);
    return true;
  } catch (error) {
    console.error('❌ Groq Error:', error.message);
    return false;
  }
}

async function testGemini() {
  console.log('\n🟢 Testing Gemini API...');
  const apiKey = process.env.GEMINI_API_KEY;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.GEMINI_CHAT}:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [{ text: 'Say "Gemini works!"' }]
        }]
      }
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('✅ Gemini Response:', text);
    return true;
  } catch (error) {
    console.error('❌ Gemini Error:', error.response?.data || error.message);
    return false;
  }
}

async function main() {
  const groqWorks = await testGroq();
  const geminiWorks = await testGemini();

  console.log('\n' + '='.repeat(50));
  console.log('RESULTS:');
  console.log('Groq:', groqWorks ? '✅ Working' : '❌ Failed');
  console.log('Gemini:', geminiWorks ? '✅ Working' : '❌ Failed');
  console.log('='.repeat(50) + '\n');

  if (!groqWorks && !geminiWorks) {
    console.error('⛔ CRITICAL: Both AI providers failed!');
    process.exit(1);
  }
}

main();
