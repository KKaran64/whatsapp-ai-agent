/**
 * Rate Limiting Test for WhatsApp Media Upload
 * Simulates rapid requests to verify throttling works correctly
 */

const { uploadImageToWhatsApp } = require('./whatsapp-media-upload');

console.log('============================================================');
console.log('Testing Rate Limiting (30 requests/minute limit)');
console.log('============================================================\n');

const TEST_IMAGE_URL = 'https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg';

async function testRateLimiting() {
  const requests = 5; // Send 5 requests rapidly
  const startTime = Date.now();

  console.log(`Sending ${requests} rapid requests to test rate limiting...\n`);

  const promises = [];
  for (let i = 0; i < requests; i++) {
    const promise = (async (index) => {
      const reqStart = Date.now();
      try {
        console.log(`[Request ${index + 1}] Starting at ${(reqStart - startTime)}ms...`);
        await uploadImageToWhatsApp(TEST_IMAGE_URL);
        const reqEnd = Date.now();
        console.log(`[Request ${index + 1}] ✅ Completed at ${(reqEnd - startTime)}ms (took ${reqEnd - reqStart}ms)`);
      } catch (error) {
        const reqEnd = Date.now();
        console.log(`[Request ${index + 1}] ❌ Failed at ${(reqEnd - startTime)}ms: ${error.message}`);
      }
    })(i);

    promises.push(promise);

    // Small delay to space out request initiation
    if (i < requests - 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  await Promise.all(promises);

  const totalTime = Date.now() - startTime;
  const avgTime = totalTime / requests;

  console.log('\n============================================================');
  console.log('Rate Limiting Test Results');
  console.log('============================================================');
  console.log(`Total Requests: ${requests}`);
  console.log(`Total Time: ${totalTime}ms`);
  console.log(`Average Time per Request: ${avgTime.toFixed(0)}ms`);
  console.log(`Expected Min Interval: 100ms between requests`);
  console.log(`\nRate limiting is working if:`);
  console.log(`- Average time ≥ 100ms (current: ${avgTime.toFixed(0)}ms)`);
  console.log(`- Requests spread out over time (not all instant)`);
  console.log('============================================================\n');

  if (avgTime >= 100) {
    console.log('✅ Rate limiting is working correctly!\n');
  } else {
    console.log('⚠️ Rate limiting may not be working as expected\n');
  }
}

testRateLimiting().catch(console.error);
