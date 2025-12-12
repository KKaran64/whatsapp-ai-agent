// Test script to verify Groq API tier and token limits
require('dotenv').config();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function testTokenLimits() {
  console.log('🔍 Testing Groq API Token Limits...\n');

  // Test 1: Small request (should work on all tiers)
  console.log('Test 1: Small request (~500 tokens)...');
  try {
    const smallTest = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Say hello' }
      ],
      model: 'llama-3.3-70b-versatile',
      max_tokens: 100
    });
    console.log('✅ Small request succeeded');
    console.log('Response:', smallTest.choices[0]?.message?.content);
  } catch (error) {
    console.error('❌ Small request failed:', error.message);
  }

  // Test 2: Medium request (~8,000 tokens - free tier limit was 12k)
  console.log('\nTest 2: Medium request (~8,000 tokens)...');
  const mediumPrompt = `You are Priya, a consultative sales expert for 9 Cork Sustainable Products.

═══════════════════════════════════════
🌳 CORK KNOWLEDGE
═══════════════════════════════════════
Cork is bark from Cork Oak trees - harvested every 9-10 years WITHOUT cutting trees. Trees live 200+ years, absorb 5x more CO2 after harvest. 100% natural, biodegradable, water-resistant, heat-resistant, anti-microbial.

═══════════════════════════════════════
🚨 CRITICAL RULES
═══════════════════════════════════════

**1. STRICT PRICE BLOCKING - NEVER mention prices until you have ALL 4:**
☐ WHY (use case/occasion)
☐ WHO (recipients/audience)
☐ WHEN (timeline)
☐ BRANDING (logo needed?)

**2. WHATSAPP BREVITY - Maximum 2 sentences**
Keep EVERY message SHORT!

**3. CONVERSATION MEMORY**
ALWAYS reference what customer already told you.

═══════════════════════════════════════
📋 PRODUCT CATALOG
═══════════════════════════════════════

🟤 CORK COASTERS (16 types, ₹20-₹120/100pcs)
🟤 CORK DIARIES (₹90-₹240/100pcs)
🟤 DESK ORGANIZERS (₹90-₹550)
🟤 PLANTERS (₹130-₹900)
🟤 PHOTO FRAMES (₹280-₹350)
🟤 BAGS, WALLETS & ACCESSORIES (₹95-₹950)

Respond with a greeting.`.repeat(4); // Repeat to make it larger

  try {
    const mediumTest = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: mediumPrompt },
        { role: 'user', content: 'Hi' }
      ],
      model: 'llama-3.3-70b-versatile',
      max_tokens: 100
    });
    console.log('✅ Medium request succeeded (~8k tokens)');
    console.log('Response:', mediumTest.choices[0]?.message?.content);
  } catch (error) {
    console.error('❌ Medium request failed:', error.message);
    if (error.message.includes('Limit')) {
      const match = error.message.match(/Limit (\d+)/);
      if (match) {
        console.log(`📊 Detected token limit: ${match[1]} tokens`);
      }
    }
  }

  // Test 3: Large request (~20,000 tokens - would fail on free tier, succeed on Growth tier)
  console.log('\nTest 3: Large request (~20,000 tokens - Growth tier test)...');
  const largePrompt = mediumPrompt.repeat(3); // Make it much larger

  try {
    const largeTest = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: largePrompt },
        { role: 'user', content: 'Hi' }
      ],
      model: 'llama-3.3-70b-versatile',
      max_tokens: 100
    });
    console.log('✅ Large request succeeded (~20k tokens)');
    console.log('🎉 CONFIRMED: You have Groq Growth tier or higher (32k+ limit)!');
    console.log('Response:', largeTest.choices[0]?.message?.content);
  } catch (error) {
    console.error('❌ Large request failed:', error.message);
    if (error.message.includes('Limit')) {
      const match = error.message.match(/Limit (\d+)/);
      if (match) {
        const limit = parseInt(match[1]);
        console.log(`\n📊 DETECTED TOKEN LIMIT: ${limit.toLocaleString()} tokens`);

        if (limit === 12000) {
          console.log('⚠️  You are still on FREE tier (12k limit)');
          console.log('   Please upgrade your Groq account to Growth tier');
        } else if (limit >= 32000 && limit < 128000) {
          console.log('✅ You are on GROWTH tier (32k limit)');
        } else if (limit >= 128000) {
          console.log('✅ You are on PRO tier (128k limit)');
        }
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('Groq API Tier Information:');
  console.log('- FREE tier: 12,000 token limit');
  console.log('- GROWTH tier: 32,000 token limit');
  console.log('- PRO tier: 128,000 token limit');
  console.log('='.repeat(50));
}

testTokenLimits().catch(console.error);
