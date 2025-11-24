#!/usr/bin/env node

/**
 * Quick verification test for the improvements
 */

require('dotenv').config();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Read the updated system prompt from server-production.js
const fs = require('fs');
const serverCode = fs.readFileSync('./server-production.js', 'utf8');
const promptMatch = serverCode.match(/content: `(You are Priya.*?)`,\s*}/s);
const systemPrompt = promptMatch ? promptMatch[1] : '';

// Test the specific scenario that was weak
const testCases = [
  {
    name: 'Pricing - Specific Product (Previously 3.5/5)',
    message: 'Price for Premium Square Fabric coasters?',
    expectedBehavior: 'Should ask quantity FIRST before giving price',
  },
  {
    name: 'HORECA - Branding Mention',
    message: "We're opening a new cafe and need coasters",
    expectedBehavior: 'Should mention branding capability',
  },
  {
    name: 'Wedding Favors - Combo Numbers',
    message: 'Need wedding return gifts for 200 guests',
    expectedBehavior: 'Should suggest specific combo numbers',
  },
];

async function testScenario(testCase) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: testCase.message }
  ];

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: messages,
    temperature: 0.7,
    max_tokens: 500,
    top_p: 1,
    stream: false
  });

  return completion.choices[0]?.message?.content || "No response";
}

async function runTests() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║        ✅ Verification Test - Updated System Prompt      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  for (let i = 0; i < testCases.length; i++) {
    const test = testCases[i];
    console.log(`\n[${i + 1}/${testCases.length}] ${test.name}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(`📩 Message: "${test.message}"`);
    console.log(`📋 Expected: ${test.expectedBehavior}`);

    const response = await testScenario(test);
    console.log(`🤖 Response: ${response}`);

    // Simple validation
    let passed = false;
    if (i === 0) {
      // Pricing test - should ask about quantity
      passed = response.toLowerCase().includes('quantity') ||
               response.toLowerCase().includes('how many') ||
               response.toLowerCase().includes('pieces');
    } else if (i === 1) {
      // HORECA test - should mention branding/logo
      passed = response.toLowerCase().includes('brand') ||
               response.toLowerCase().includes('logo') ||
               response.toLowerCase().includes('custom');
    } else if (i === 2) {
      // Wedding test - should mention combo numbers or specific combos
      passed = response.toLowerCase().includes('combo') &&
               (response.includes('13') || response.includes('14') ||
                response.includes('37') || response.includes('38'));
    }

    console.log(`\n${passed ? '✅ PASS' : '⚠️  CHECK'} - ${passed ? 'Improvement verified!' : 'Review response above'}`);

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                  🎉 VERIFICATION COMPLETE                ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log('💡 If all tests show ✅ PASS, the improvements are working!\n');
  console.log('📝 You can now test interactively with: node test-ai-locally.js\n');
}

if (!process.env.GROQ_API_KEY) {
  console.error('❌ Error: GROQ_API_KEY not found in .env file');
  process.exit(1);
}

runTests().catch(console.error);
