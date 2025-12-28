/**
 * AI RESPONSE VALIDATION TESTS
 *
 * Tests AI response patterns for critical bugs
 * This requires access to conversation logs or database
 *
 * Usage: node tests/ai-response-validation.js
 */

const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');

// Response validation patterns
const VALIDATION_RULES = {
  // v39, v50: Catalog request should NOT ask for email
  catalogNoEmailAsk: {
    name: 'Catalog request - No email ask',
    trigger: /catalog|catalogue|brochure|pdf/i,
    forbidden: [
      /please share your email/i,
      /share your whatsapp number/i,
      /send.*email/i,
      /email.*and.*whatsapp/i
    ],
    required: [
      /catalog|catalogue|brochure/i
    ],
    description: 'When customer asks for catalog, should NOT ask for email/WhatsApp'
  },

  // v48: Should NOT hallucinate quantities
  noQuantityHallucination: {
    name: 'No quantity hallucination',
    trigger: /clients|employees|gifting/i,
    forbidden: [
      /for 200/i,
      /for 100/i,
      /for 150/i,
      /for 250/i,
      /for 300/i
    ],
    required: [
      /how many/i
    ],
    description: 'Should ask for quantity instead of assuming'
  },

  // v38: Should NOT change products mid-conversation
  productAccuracy: {
    name: 'Product accuracy - No product switching',
    trigger: /diary|diaries/i,
    forbidden: [
      /coasters/i,
      /planters/i,
      /wallet/i
    ],
    required: [
      /diary|diaries/i
    ],
    description: 'Should stick to the product customer asked about'
  },

  // v41: Should NOT send rude rate limit messages
  noRudeRateLimit: {
    name: 'No rude rate limit messages',
    trigger: /.*/,
    forbidden: [
      /please wait.*before sending/i,
      /too many messages/i,
      /slow down/i
    ],
    description: 'Should never send rate limit warnings to customer'
  },

  // v44: Should NOT over-promise images
  noImageOverpromise: {
    name: 'No image over-promising',
    trigger: /do you have|what.*available/i,
    forbidden: [
      /let me show you/i,
      /i'll send you images/i,
      /i'll send pictures/i
    ],
    description: 'Should not promise images unless customer explicitly requests'
  }
};

async function validateConversation(phoneNumber, ruleKey) {
  const rule = VALIDATION_RULES[ruleKey];

  try {
    // Get recent conversation
    const conversation = await Conversation.findOne({ phoneNumber })
      .sort({ updatedAt: -1 })
      .limit(1);

    if (!conversation) {
      return { pass: false, error: 'No conversation found' };
    }

    const messages = conversation.messages;
    if (messages.length < 2) {
      return { pass: false, error: 'Not enough messages to validate' };
    }

    // Find customer trigger message and bot response
    let triggerFound = false;
    let violations = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Check if customer message matches trigger
      if (msg.role === 'customer' && rule.trigger.test(msg.content)) {
        triggerFound = true;

        // Check next bot response
        if (i + 1 < messages.length && messages[i + 1].role === 'assistant') {
          const botResponse = messages[i + 1].content;

          // Check forbidden patterns
          for (const forbiddenPattern of rule.forbidden) {
            if (forbiddenPattern.test(botResponse)) {
              violations.push({
                type: 'forbidden',
                pattern: forbiddenPattern.source,
                found: botResponse.match(forbiddenPattern)[0]
              });
            }
          }

          // Check required patterns
          if (rule.required) {
            for (const requiredPattern of rule.required) {
              if (!requiredPattern.test(botResponse)) {
                violations.push({
                  type: 'missing_required',
                  pattern: requiredPattern.source,
                  response: botResponse
                });
              }
            }
          }
        }
      }
    }

    if (!triggerFound) {
      return { pass: true, skipped: true, reason: 'Trigger pattern not found in conversation' };
    }

    if (violations.length > 0) {
      return { pass: false, violations };
    }

    return { pass: true };

  } catch (error) {
    return { pass: false, error: error.message };
  }
}

async function runValidationTests() {
  console.log('🧪 Starting AI Response Validation Tests\n');
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-sales');
    console.log('✅ Connected to MongoDB\n');

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    const failures = [];

    // Get recent conversations to test
    const recentConversations = await Conversation.find()
      .sort({ updatedAt: -1 })
      .limit(10);

    console.log(`📊 Testing ${recentConversations.length} recent conversations\n`);

    // Run all validation rules on each conversation
    for (const conversation of recentConversations) {
      console.log(`📱 Testing conversation: ${conversation.phoneNumber}\n`);

      for (const [ruleKey, rule] of Object.entries(VALIDATION_RULES)) {
        totalTests++;
        const result = await validateConversation(conversation.phoneNumber, ruleKey);

        if (result.skipped) {
          console.log(`⏭️  SKIP: ${rule.name} - ${result.reason}`);
          totalTests--; // Don't count skipped tests
          continue;
        }

        if (result.pass) {
          passedTests++;
          console.log(`✅ PASS: ${rule.name}`);
        } else {
          failedTests++;
          console.log(`❌ FAIL: ${rule.name}`);
          if (result.violations) {
            result.violations.forEach(v => {
              if (v.type === 'forbidden') {
                console.log(`   Found forbidden pattern: "${v.found}"`);
              } else {
                console.log(`   Missing required pattern: ${v.pattern}`);
              }
            });
          } else if (result.error) {
            console.log(`   Error: ${result.error}`);
          }
          failures.push({
            conversation: conversation.phoneNumber,
            rule: rule.name,
            result
          });
        }
      }

      console.log(''); // Blank line between conversations
    }

    // Results summary
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 VALIDATION RESULTS SUMMARY\n');
    console.log(`Total Tests: ${totalTests}`);
    console.log(`✅ Passed: ${passedTests}`);
    console.log(`❌ Failed: ${failedTests}`);
    console.log(`Success Rate: ${totalTests > 0 ? ((passedTests/totalTests)*100).toFixed(1) : 0}%`);

    if (failedTests > 0) {
      console.log('\n❌ FAILED VALIDATIONS:\n');
      failures.forEach((failure, index) => {
        console.log(`${index + 1}. ${failure.rule} (${failure.conversation})`);
        if (failure.result.violations) {
          failure.result.violations.forEach(v => {
            console.log(`   - ${v.type}: ${v.pattern || v.found}`);
          });
        }
        console.log('');
      });
    } else {
      console.log('\n✅ ALL VALIDATIONS PASSED!\n');
    }

    await mongoose.disconnect();
    process.exit(failedTests > 0 ? 1 : 0);

  } catch (error) {
    console.error('\n❌ VALIDATION ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  runValidationTests();
}

module.exports = { validateConversation, VALIDATION_RULES };
