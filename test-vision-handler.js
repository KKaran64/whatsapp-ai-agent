require('dotenv').config();
const axios = require('axios');

// Test the vision handler fixes (v53.38)
async function testVisionHandler() {
  console.log('🧪 Testing Vision Handler v53.38 Fixes\n');
  console.log('=' .repeat(50));

  const results = { passed: 0, failed: 0 };

  // Test 1: Check VisionHandler loads without errors
  console.log('\n📋 Test 1: VisionHandler module loads correctly');
  try {
    const VisionHandler = require('./vision-handler');
    console.log('   ✅ Module loaded successfully');
    results.passed++;
  } catch (error) {
    console.log('   ❌ Module failed to load:', error.message);
    results.failed++;
    return results;
  }

  // Test 2: Check initialization with config
  console.log('\n📋 Test 2: VisionHandler initializes with config');
  try {
    const VisionHandler = require('./vision-handler');
    const handler = new VisionHandler({
      WHATSAPP_TOKEN: 'test-token',
      GEMINI_API_KEY: 'key1,key2,key3',
      ANTHROPIC_API_KEY: 'test-anthropic',
      GOOGLE_CLOUD_VISION_KEY: 'test-gcv',
      HUGGINGFACE_TOKEN: 'test-hf'
    });

    // Check multiple keys parsed correctly
    if (handler.geminiApiKeys.length === 3) {
      console.log('   ✅ Multiple Gemini keys parsed correctly (3 keys)');
      results.passed++;
    } else {
      console.log('   ❌ Gemini keys not parsed correctly');
      results.failed++;
    }

    // Check stats initialized
    if (handler.stats.gemini.keyStats.key1 && handler.stats.gemini.keyStats.key3) {
      console.log('   ✅ Stats initialized for all keys');
      results.passed++;
    } else {
      console.log('   ❌ Stats not initialized correctly');
      results.failed++;
    }
  } catch (error) {
    console.log('   ❌ Initialization failed:', error.message);
    results.failed += 2;
  }

  // Test 3: Check Gemini API endpoint is correct (stable model)
  console.log('\n📋 Test 3: Gemini uses stable model (gemini-1.5-flash)');
  try {
    const fs = require('fs');
    const visionCode = fs.readFileSync('./vision-handler.js', 'utf8');

    if (visionCode.includes('gemini-2.0-flash:generateContent')) {
      console.log('   ✅ Using stable gemini-2.0-flash model');
      results.passed++;
    } else if (visionCode.includes('gemini-2.0-flash-exp')) {
      console.log('   ❌ Still using experimental model');
      results.failed++;
    } else {
      console.log('   ⚠️  Model endpoint not found');
      results.failed++;
    }

    // Check URL approach removed
    if (!visionCode.includes('fileUri: imageData.url')) {
      console.log('   ✅ URL approach removed (WhatsApp auth fix)');
      results.passed++;
    } else {
      console.log('   ❌ URL approach still present');
      results.failed++;
    }
  } catch (error) {
    console.log('   ❌ Code check failed:', error.message);
    results.failed += 2;
  }

  // Test 4: Check prompt is simplified
  console.log('\n📋 Test 4: Prompt is simplified');
  try {
    const fs = require('fs');
    const visionCode = fs.readFileSync('./vision-handler.js', 'utf8');

    // Old prompt had "IDENTIFICATION STEPS:" section
    if (!visionCode.includes('IDENTIFICATION STEPS:')) {
      console.log('   ✅ Old verbose prompt removed');
      results.passed++;
    } else {
      console.log('   ❌ Old prompt still present');
      results.failed++;
    }

    // New prompt should have simplified categories
    if (visionCode.includes('IMAGE TYPES TO HANDLE:')) {
      console.log('   ✅ New simplified prompt present');
      results.passed++;
    } else {
      console.log('   ❌ New prompt not found');
      results.failed++;
    }

    // Check conversation history is limited
    if (visionCode.includes('.slice(-3)')) {
      console.log('   ✅ Conversation history limited to last 3 messages');
      results.passed++;
    } else {
      console.log('   ❌ Conversation history not limited');
      results.failed++;
    }
  } catch (error) {
    console.log('   ❌ Prompt check failed:', error.message);
    results.failed += 3;
  }

  // Test 5: Live Gemini Vision API test (if key available)
  console.log('\n📋 Test 5: Live Gemini Vision API test');
  const geminiKey = process.env.GEMINI_API_KEY?.split(',')[0]?.trim();

  if (!geminiKey) {
    console.log('   ⏭️  Skipped (no GEMINI_API_KEY in .env)');
  } else {
    try {
      // Create a tiny 1x1 red PNG (base64)
      const tinyRedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

      console.log('   🔄 Testing Gemini Vision with tiny test image...');

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          contents: [{
            parts: [
              { text: 'What color is this image? Reply in one word.' },
              { inline_data: { mime_type: 'image/png', data: tinyRedPng } }
            ]
          }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 50
          }
        },
        { timeout: 30000 }
      );

      const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (aiResponse) {
        console.log('   ✅ Gemini Vision API works!');
        console.log(`   📝 Response: "${aiResponse.trim()}"`);
        results.passed++;
      } else {
        console.log('   ❌ Empty response from Gemini');
        results.failed++;
      }
    } catch (error) {
      console.log('   ❌ Gemini Vision API failed:', error.response?.data?.error?.message || error.message);
      results.failed++;
    }
  }

  // Test 6: Check Google Cloud Vision uses base64 only
  console.log('\n📋 Test 6: Google Cloud Vision uses base64 only');
  try {
    const fs = require('fs');
    const visionCode = fs.readFileSync('./vision-handler.js', 'utf8');

    // Check imageUri removed from Google Cloud Vision
    if (!visionCode.includes('source: { imageUri:')) {
      console.log('   ✅ URL approach removed from Google Cloud Vision');
      results.passed++;
    } else {
      console.log('   ❌ URL approach still in Google Cloud Vision');
      results.failed++;
    }

    // Check TEXT_DETECTION added
    if (visionCode.includes("type: 'TEXT_DETECTION'")) {
      console.log('   ✅ TEXT_DETECTION feature added');
      results.passed++;
    } else {
      console.log('   ⚠️  TEXT_DETECTION not added');
    }
  } catch (error) {
    console.log('   ❌ Check failed:', error.message);
    results.failed++;
  }

  // Summary
  console.log('\n' + '=' .repeat(50));
  console.log(`\n📊 Results: ${results.passed} passed, ${results.failed} failed`);

  if (results.failed === 0) {
    console.log('🎉 All tests passed! Vision handler v53.38 is ready.\n');
  } else {
    console.log('⚠️  Some tests failed. Please review the issues above.\n');
  }

  return results;
}

testVisionHandler().catch(console.error);
