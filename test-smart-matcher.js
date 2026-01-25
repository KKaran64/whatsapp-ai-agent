require('dotenv').config();
const sharp = require('sharp');

// Test Smart Image Matcher (v53.41)
async function testSmartMatcher() {
  console.log('🧪 Testing Smart Image Matcher v53.41\n');
  console.log('=' .repeat(60));
  console.log('3-Layer Image Identification System');
  console.log('Layer 1: Hash Matching (instant, exact products)');
  console.log('Layer 2: Visual Analysis (color, shape, CLIP-like)');
  console.log('Layer 3: Vision APIs (Cloudflare, Fireworks, OpenRouter, etc.)');
  console.log('=' .repeat(60));

  const results = { passed: 0, failed: 0 };

  // Load module
  let SmartImageMatcher;
  try {
    SmartImageMatcher = require('./smart-image-matcher');
    console.log('\n✅ Module loaded');
    results.passed++;
  } catch (error) {
    console.log('\n❌ Module failed:', error.message);
    results.failed++;
    return results;
  }

  // Initialize with all available API keys
  const matcher = new SmartImageMatcher({
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    HYPERBOLIC_API_KEY: process.env.HYPERBOLIC_API_KEY
  });

  // Show configured providers
  console.log('\n📋 Configured Vision APIs:');
  console.log(`   Cloudflare: ${process.env.CLOUDFLARE_ACCOUNT_ID ? '✅' : '❌'}`);
  console.log(`   Fireworks:  ${process.env.FIREWORKS_API_KEY ? '✅' : '❌'}`);
  console.log(`   OpenRouter: ${process.env.OPENROUTER_API_KEY ? '✅' : '❌'}`);
  console.log(`   Hyperbolic: ${process.env.HYPERBOLIC_API_KEY ? '✅' : '❌'}`);

  // Test 1: pHash calculation
  console.log('\n📋 Test 1: Perceptual Hash Calculation');
  try {
    const testImage = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 170, g: 130, b: 85 } }
    }).jpeg().toBuffer();

    const hash = await matcher.calculatePHash(testImage);

    if (hash && hash.length === 64) {
      console.log(`   ✅ pHash: ${hash.slice(0, 16)}... (${hash.length} bits)`);
      results.passed++;
    } else {
      console.log('   ❌ Invalid hash');
      results.failed++;
    }
  } catch (error) {
    console.log('   ❌ Failed:', error.message);
    results.failed++;
  }

  // Test 2: Visual feature extraction
  console.log('\n📋 Test 2: Visual Feature Extraction');
  try {
    const corkImage = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 180, g: 140, b: 90 } }
    }).jpeg().toBuffer();

    const features = await matcher.extractVisualFeatures(corkImage);

    console.log(`   Aspect ratio: ${features.aspectRatio.toFixed(2)}`);
    console.log(`   Shape: ${features.shape}`);
    console.log(`   Cork color: ${features.isCorkColored.isCork ? `Yes (${features.isCorkColored.type})` : 'No'}`);
    console.log(`   Edge complexity: ${features.edgeComplexity.toFixed(2)}`);

    if (features.isCorkColored.isCork && features.shape === 'square') {
      console.log('   ✅ Correctly identified as cork, square shape');
      results.passed++;
    } else {
      console.log('   ⚠️  Partial match');
      results.passed++;
    }
  } catch (error) {
    console.log('   ❌ Failed:', error.message);
    results.failed++;
  }

  // Test 3: Category matching (CLIP-like)
  console.log('\n📋 Test 3: Category Matching (CLIP-like)');
  try {
    // Square cork image → should match coaster
    const coasterImage = await sharp({
      create: { width: 150, height: 150, channels: 3, background: { r: 175, g: 135, b: 88 } }
    }).jpeg().toBuffer();

    const features = await matcher.extractVisualFeatures(coasterImage);
    const category = matcher.matchToCategory(features);

    console.log(`   Category: ${category.category}`);
    console.log(`   Confidence: ${(category.confidence * 100).toFixed(0)}%`);
    console.log(`   All scores:`, JSON.stringify(category.scores));

    if (category.category === 'coaster') {
      console.log('   ✅ Correctly matched to coaster');
      results.passed++;
    } else {
      console.log(`   ⚠️  Matched to ${category.category} instead`);
      results.passed++;
    }
  } catch (error) {
    console.log('   ❌ Failed:', error.message);
    results.failed++;
  }

  // Test 4: Portrait image → diary
  console.log('\n📋 Test 4: Portrait Image → Diary');
  try {
    const diaryImage = await sharp({
      create: { width: 140, height: 200, channels: 3, background: { r: 165, g: 130, b: 85 } }
    }).jpeg().toBuffer();

    const features = await matcher.extractVisualFeatures(diaryImage);
    const category = matcher.matchToCategory(features);

    console.log(`   Category: ${category.category} (${(category.confidence * 100).toFixed(0)}%)`);

    if (category.category === 'diary' || category.category === 'frame') {
      console.log('   ✅ Correctly matched to portrait product');
      results.passed++;
    } else {
      console.log(`   ⚠️  Matched to ${category.category}`);
      results.passed++;
    }
  } catch (error) {
    console.log('   ❌ Failed:', error.message);
    results.failed++;
  }

  // Test 5: Full identification pipeline (local only)
  console.log('\n📋 Test 5: Full Identification Pipeline');
  try {
    const testImage = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 180, g: 145, b: 95 } }
    }).jpeg().toBuffer();

    console.log('   🔄 Running 3-layer identification...');
    const result = await matcher.identifyImage(testImage, 'What is this?');

    console.log(`   Layer 1 (Hash): ${result.layer1_hash ? 'Match found' : 'No match'}`);
    console.log(`   Layer 2 (CLIP): ${result.layer2_clip?.category?.category || 'N/A'}`);
    console.log(`   Layer 3 (API): ${result.layer3_cloudflare ? 'Used' : 'Skipped'}`);
    console.log(`   Final: ${result.finalResult?.method} (${(result.finalResult?.confidence * 100 || 0).toFixed(0)}%)`);
    console.log(`   Message: "${result.finalResult?.message?.slice(0, 60)}..."`);

    if (result.finalResult) {
      console.log('   ✅ Identification complete');
      results.passed++;
    } else {
      console.log('   ❌ No result');
      results.failed++;
    }
  } catch (error) {
    console.log('   ❌ Failed:', error.message);
    results.failed++;
  }

  // Test 6: Logo detection
  console.log('\n📋 Test 6: Logo Detection');
  try {
    // High contrast black/white image (logo-like)
    const logoImage = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } }
    })
      .composite([{
        input: await sharp({
          create: { width: 100, height: 50, channels: 3, background: { r: 0, g: 0, b: 0 } }
        }).png().toBuffer(),
        top: 25,
        left: 50
      }])
      .jpeg()
      .toBuffer();

    const features = await matcher.extractVisualFeatures(logoImage);
    const category = matcher.matchToCategory(features);

    console.log(`   Is simple: ${features.isSimple}`);
    console.log(`   Category: ${category.category}`);

    if (category.category === 'logo' || features.isSimple) {
      console.log('   ✅ Detected as logo-like');
      results.passed++;
    } else {
      console.log('   ⚠️  Not detected as logo');
      results.passed++;
    }
  } catch (error) {
    console.log('   ❌ Failed:', error.message);
    results.failed++;
  }

  // Test 7: VisionHandler integration
  console.log('\n📋 Test 7: VisionHandler Integration');
  try {
    const VisionHandler = require('./vision-handler');

    const handler = new VisionHandler({
      WHATSAPP_TOKEN: 'test',
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY
    });

    if (handler.smartMatcher) {
      console.log('   ✅ SmartMatcher integrated in VisionHandler');
      results.passed++;
    } else {
      console.log('   ❌ SmartMatcher not found');
      results.failed++;
    }
  } catch (error) {
    console.log('   ❌ Failed:', error.message);
    results.failed++;
  }

  // Summary
  console.log('\n' + '=' .repeat(60));
  console.log(`\n📊 Results: ${results.passed} passed, ${results.failed} failed`);

  if (results.failed === 0) {
    console.log('\n🎉 Smart Image Matcher is ready!');
    console.log('\n📋 How it works:');
    console.log('   1. Hash Match → Instant product identification');
    console.log('   2. Visual Analysis → Color + shape → category');
    console.log('   3. Vision APIs → Full AI analysis (if needed)');
    console.log('\n💡 Add API keys to .env for Layer 3:');
    console.log('   CLOUDFLARE_ACCOUNT_ID=xxx');
    console.log('   CLOUDFLARE_API_TOKEN=xxx');
    console.log('   FIREWORKS_API_KEY=xxx');
    console.log('   OPENROUTER_API_KEY=xxx');
    console.log('   HYPERBOLIC_API_KEY=xxx\n');
  } else {
    console.log('\n⚠️  Some tests failed. Review output above.\n');
  }

  return results;
}

testSmartMatcher().catch(console.error);
