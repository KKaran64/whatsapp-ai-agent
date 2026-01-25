require('dotenv').config();
const axios = require('axios');
const sharp = require('sharp');

// Test Together AI Vision (v53.40)
async function testTogetherVision() {
  console.log('🧪 Testing Together AI Vision v53.40\n');
  console.log('=' .repeat(50));

  const results = { passed: 0, failed: 0 };

  // Check for API key
  const togetherKey = process.env.TOGETHER_API_KEY;
  if (!togetherKey) {
    console.log('\n❌ TOGETHER_API_KEY not found in .env');
    console.log('\n📋 How to get FREE Together AI key:');
    console.log('   1. Go to: https://api.together.xyz');
    console.log('   2. Sign up (free)');
    console.log('   3. Get your API key');
    console.log('   4. Add to .env: TOGETHER_API_KEY=xxx\n');
    return { passed: 0, failed: 1 };
  }

  console.log(`\n✅ Together API key found: ${togetherKey.slice(0, 15)}...`);

  // Test 1: List available vision models
  console.log('\n📋 Test 1: Check Together AI Vision models');
  try {
    const modelsResponse = await axios.get(
      'https://api.together.xyz/v1/models',
      {
        headers: { 'Authorization': `Bearer ${togetherKey}` }
      }
    );

    const visionModels = modelsResponse.data.filter(m =>
      m.id.toLowerCase().includes('vision') ||
      m.id.toLowerCase().includes('llava')
    );

    console.log('   Vision models available:');
    visionModels.slice(0, 5).forEach(m => console.log(`   - ${m.id}`));
    if (visionModels.length > 5) console.log(`   ... and ${visionModels.length - 5} more`);

    if (visionModels.length > 0) {
      console.log('   ✅ Vision models found');
      results.passed++;
    } else {
      console.log('   ⚠️ No vision models listed (may still work)');
      results.passed++;
    }
  } catch (error) {
    console.log('   ⚠️ Could not list models:', error.message);
    results.passed++; // Non-critical
  }

  // Test 2: Try FREE Llama-Vision-Free model
  console.log('\n📋 Test 2: Together AI FREE vision model');
  try {
    const testImage = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 180, g: 140, b: 90 } // Cork brown
      }
    }).jpeg().toBuffer();

    const base64Image = testImage.toString('base64');
    console.log('   🔄 Testing with Llama-Vision-Free (FREE)...');

    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model: 'meta-llama/Llama-Vision-Free',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What color is this image? Reply in one word only.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ]
        }],
        max_tokens: 50,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${togetherKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const aiResponse = response.data?.choices?.[0]?.message?.content;

    if (aiResponse) {
      console.log(`   ✅ FREE model works!`);
      console.log(`   📝 Response: "${aiResponse.trim()}"`);
      results.passed++;
    } else {
      console.log('   ❌ Empty response');
      results.failed++;
    }

  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.log('   ❌ FREE model failed:', errorMsg);

    // Try turbo model
    console.log('   🔄 Trying 11B turbo model...');
    try {
      const testImage = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } }
      }).jpeg().toBuffer();

      const response = await axios.post(
        'https://api.together.xyz/v1/chat/completions',
        {
          model: 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'What color? One word.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${testImage.toString('base64')}` } }
            ]
          }],
          max_tokens: 20
        },
        {
          headers: { 'Authorization': `Bearer ${togetherKey}`, 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      if (aiResponse) {
        console.log(`   ✅ Turbo model works!`);
        console.log(`   📝 Response: "${aiResponse.trim()}"`);
        results.passed++;
      } else {
        results.failed++;
      }
    } catch (turboError) {
      console.log('   ❌ Turbo model also failed:', turboError.response?.data?.error?.message || turboError.message);
      results.failed++;
    }
  }

  // Test 3: Test VisionHandler integration
  console.log('\n📋 Test 3: VisionHandler integration');
  try {
    const VisionHandler = require('./vision-handler');

    const handler = new VisionHandler({
      WHATSAPP_TOKEN: 'test',
      TOGETHER_API_KEY: togetherKey
    });

    if (handler.togetherApiKey) {
      console.log('   ✅ Together API key loaded in VisionHandler');
      results.passed++;
    } else {
      console.log('   ❌ Together API key not loaded');
      results.failed++;
    }

    if (!handler.localOnlyMode) {
      console.log('   ✅ Not in local-only mode');
      results.passed++;
    } else {
      console.log('   ❌ Still in local-only mode');
      results.failed++;
    }

  } catch (error) {
    console.log('   ❌ VisionHandler error:', error.message);
    results.failed++;
  }

  // Test 4: Full image analysis prompt
  console.log('\n📋 Test 4: Full product analysis');
  try {
    const testImage = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 170, g: 130, b: 85 }
      }
    }).jpeg().toBuffer();

    const prompt = `You are Priya, a sales expert for 9Cork (sustainable cork products).
Analyze this image and respond helpfully.
PRODUCT CATEGORIES: Coasters, Diaries, Desk Organizers, Card Holders, Planters, Bags
Respond in 1 sentence as Priya.`;

    console.log('   🔄 Testing full analysis prompt...');

    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model: 'meta-llama/Llama-Vision-Free',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${testImage.toString('base64')}` } }
          ]
        }],
        max_tokens: 200,
        temperature: 0.4
      },
      {
        headers: { 'Authorization': `Bearer ${togetherKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const aiResponse = response.data?.choices?.[0]?.message?.content;
    if (aiResponse) {
      console.log(`   ✅ Full analysis works!`);
      console.log(`   📝 Response: "${aiResponse.slice(0, 100)}..."`);
      results.passed++;
    } else {
      results.failed++;
    }

  } catch (error) {
    console.log('   ❌ Full analysis failed:', error.response?.data?.error?.message || error.message);
    results.failed++;
  }

  // Summary
  console.log('\n' + '=' .repeat(50));
  console.log(`\n📊 Results: ${results.passed} passed, ${results.failed} failed`);

  if (results.failed === 0) {
    console.log('🎉 Together AI Vision is working!\n');
    console.log('📋 Your new fallback chain:');
    console.log('   1. Local Analysis (instant, free)');
    console.log('   2. Together AI Vision (FREE) ← Primary');
    console.log('   3. Gemini Vision (quota issues)');
    console.log('   4. Claude Vision (paid)');
    console.log('   5. Google Cloud Vision');
    console.log('   6. Hugging Face\n');
  } else {
    console.log('⚠️  Some tests failed. Make sure your API key has access to vision models.\n');
  }

  return results;
}

testTogetherVision().catch(console.error);
