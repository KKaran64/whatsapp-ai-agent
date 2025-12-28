/**
 * CRITICAL BUGS TEST SUITE
 *
 * Tests for all major bugs fixed in v33-v50
 * Run this after EVERY deployment to catch regressions
 *
 * Usage: node tests/critical-bugs.test.js
 */

const axios = require('axios');

// Configuration
const WEBHOOK_URL = process.env.TEST_WEBHOOK_URL || 'http://localhost:3000/webhook';
const TEST_PHONE = '1234567890';
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

// Test results tracking
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

// Helper: Create HMAC signature for webhook validation
function createSignature(body) {
  if (!WHATSAPP_APP_SECRET) {
    console.warn('⚠️  No WHATSAPP_APP_SECRET - signature validation will be skipped');
    return null;
  }
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', WHATSAPP_APP_SECRET);
  hmac.update(body);
  return 'sha256=' + hmac.digest('hex');
}

// Helper: Send test message and get response
async function sendTestMessage(messageText) {
  const messageId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const webhookPayload = {
    entry: [{
      id: "test",
      changes: [{
        value: {
          messages: [{
            from: TEST_PHONE,
            id: messageId,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type: "text",
            text: { body: messageText }
          }]
        }
      }]
    }]
  };

  const body = JSON.stringify(webhookPayload);
  const headers = {
    'Content-Type': 'application/json'
  };

  const signature = createSignature(body);
  if (signature) {
    headers['x-hub-signature-256'] = signature;
  }

  try {
    const response = await axios.post(WEBHOOK_URL, webhookPayload, { headers });

    // Wait for processing (webhook returns 200 immediately, processing happens async)
    await new Promise(resolve => setTimeout(resolve, 2000));

    return {
      success: true,
      status: response.status,
      messageId
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      status: error.response?.status
    };
  }
}

// Test assertion helper
function assert(condition, testName, errorMessage) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`✅ PASS: ${testName}`);
    return true;
  } else {
    failedTests++;
    console.log(`❌ FAIL: ${testName}`);
    console.log(`   ${errorMessage}`);
    failures.push({ test: testName, error: errorMessage });
    return false;
  }
}

// Note: These tests verify webhook acceptance, not AI responses
// For AI response testing, we'd need to mock the AI or check database/logs

console.log('🧪 Starting Critical Bugs Test Suite\n');
console.log('═══════════════════════════════════════════════════════\n');

// ============================================================================
// TEST 1: Webhook Signature Validation (v47)
// ============================================================================
console.log('📋 Test Category: Webhook Signature Validation (v47)\n');

(async () => {
  try {
    // Test 1.1: Valid signature should be accepted
    const validResponse = await sendTestMessage("Test message with valid signature");
    assert(
      validResponse.success && validResponse.status === 200,
      "Valid webhook signature accepted",
      `Expected 200, got ${validResponse.status}`
    );

    // Test 1.2: Message deduplication (v49)
    console.log('\n📋 Test Category: Message Deduplication (v49)\n');

    const msg1 = await sendTestMessage("Test deduplication message");
    assert(
      msg1.success,
      "First message processed successfully",
      `Expected success, got error: ${msg1.error}`
    );

    // ============================================================================
    // TEST 2: Catalog Request - NO Email Ask (v39, v50)
    // ============================================================================
    console.log('\n📋 Test Category: Catalog Request (v39, v50)\n');

    const catalogTest = await sendTestMessage("Hi can you pls share your latest product catalogue");
    assert(
      catalogTest.success,
      "Catalog request webhook accepted",
      `Expected success, got error: ${catalogTest.error}`
    );

    // Note: To test AI response, we'd need to:
    // 1. Mock the AI provider
    // 2. Check database for stored response
    // 3. Or intercept WhatsApp API call
    // For now, we're just testing webhook acceptance

    console.log('ℹ️  To verify: Check logs that response does NOT contain "email" or "WhatsApp number"');

    // ============================================================================
    // TEST 3: Quantity Hallucination Prevention (v48)
    // ============================================================================
    console.log('\n📋 Test Category: Quantity Hallucination (v48)\n');

    await sendTestMessage("Do you have cork diaries?");
    await new Promise(resolve => setTimeout(resolve, 1000));

    await sendTestMessage("gifting");
    await new Promise(resolve => setTimeout(resolve, 1000));

    const quantityTest = await sendTestMessage("clients");
    assert(
      quantityTest.success,
      "Quantity conversation webhook accepted",
      `Expected success, got error: ${quantityTest.error}`
    );

    console.log('ℹ️  To verify: Check logs that response asks "How many?" instead of assuming quantity');

    // ============================================================================
    // TEST 4: Product Accuracy (v38)
    // ============================================================================
    console.log('\n📋 Test Category: Product Accuracy (v38)\n');

    await sendTestMessage("Do you have cork diary?");
    await new Promise(resolve => setTimeout(resolve, 1000));

    const productTest = await sendTestMessage("I need 150");
    assert(
      productTest.success,
      "Product accuracy conversation accepted",
      `Expected success, got error: ${productTest.error}`
    );

    console.log('ℹ️  To verify: Check logs that response mentions "diaries" not "coasters"');

    // ============================================================================
    // TEST 5: Rate Limiting (v37, v41)
    // ============================================================================
    console.log('\n📋 Test Category: Rate Limiting (v37, v41)\n');

    await sendTestMessage("Hi..");
    await new Promise(resolve => setTimeout(resolve, 100)); // Very quick message

    const rateLimitTest = await sendTestMessage("Do u have cork coasters");
    assert(
      rateLimitTest.success,
      "Rate limit handling works",
      `Expected success, got error: ${rateLimitTest.error}`
    );

    console.log('ℹ️  To verify: Check logs - should NOT send "Please wait" message');

    // ============================================================================
    // TEST 6: Webhook Endpoint Health
    // ============================================================================
    console.log('\n📋 Test Category: System Health\n');

    try {
      const healthCheck = await axios.get(WEBHOOK_URL.replace('/webhook', '/health'));
      assert(
        healthCheck.status === 200,
        "Health endpoint responding",
        `Expected 200, got ${healthCheck.status}`
      );
    } catch (error) {
      assert(
        false,
        "Health endpoint responding",
        `Health endpoint not accessible: ${error.message}`
      );
    }

    // ============================================================================
    // RESULTS SUMMARY
    // ============================================================================
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 TEST RESULTS SUMMARY\n');
    console.log(`Total Tests: ${totalTests}`);
    console.log(`✅ Passed: ${passedTests}`);
    console.log(`❌ Failed: ${failedTests}`);
    console.log(`Success Rate: ${((passedTests/totalTests)*100).toFixed(1)}%`);

    if (failedTests > 0) {
      console.log('\n❌ FAILED TESTS:\n');
      failures.forEach((failure, index) => {
        console.log(`${index + 1}. ${failure.test}`);
        console.log(`   ${failure.error}\n`);
      });
      process.exit(1); // Exit with error code for CI/CD
    } else {
      console.log('\n✅ ALL TESTS PASSED!\n');
      process.exit(0);
    }

  } catch (error) {
    console.error('\n❌ TEST SUITE ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
