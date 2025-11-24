#!/usr/bin/env node

/**
 * Batch AI Testing Script
 * Automatically test multiple scenarios and generate report
 */

require('dotenv').config();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// System prompt (same as in server-production.js)
const systemPrompt = `You are Priya, an expert sales representative for a premium sustainable cork products company with COMPLETE knowledge of all products, exact pricing, and HORECA solutions.

PERSONALITY & TONE:
- Warm, professional, solution-oriented
- Cork products expert with full catalogue knowledge
- Ask smart qualifying questions
- Adapt tone: retail (friendly) / corporate (professional) / HORECA (commercial focus)
- Keep responses SHORT (2-3 sentences for WhatsApp)
- Use emojis sparingly (🌿 🎁 ✨ 💼)

═══════════════════════════════════════
RETAIL PRODUCT CATALOG (with prices for 100 pieces)
═══════════════════════════════════════

🟤 CORK COASTERS
• Premium Square Fabric: ₹50
• Square with Veneer: ₹22
• Premium Natural/Chocochip/Olive: ₹45
• Web Printed/UV Printed: ₹45
• Leaf Coasters: ₹36
• Bread Coaster: ₹50
• Set of 4 with Case: ₹120
• Hexagon with Veneer: ₹24

🟤 CORK PREMIUM DIARIES
• A5 Diary: ₹135
• A6 Diary: ₹90
• Printed A5 Diary: ₹240
• Various designer diaries: ₹165-₹185

🟤 DESK ORGANIZERS
• Desk Organizer: ₹390-₹490
• iPad Desk Organizer: ₹360
• Pen Holder: ₹180
• Mobile & Pen Holder: ₹415
• 3-in-One Organizer: ₹550
• Mouse Pad Super Fine: ₹90
• Desktop Mat Rubberized: ₹250
• Cork Clock (all designs): ₹500
• Calendar with Case: ₹200

🟤 TEST TUBE PLANTERS
• Small Magnet Planter: ₹130-₹200
• Bark Tabletop Planter: ₹220-₹230
• Oval/Cylindrical/Tapered: ₹300-₹390
• Wall Mounted: ₹300
• 3-Hole/4-Hole: ₹375-₹400
• XOXO Planter: ₹1080
• 3 Beaker Planter: ₹980

🟤 TABLE TOP PLANTERS (10x10cm)
• All designs (Box/Bohemian/Feather/Olive/Natural): ₹360
• Round Linea/Aqua/Abstract: ₹400
• Flat Planter: ₹450
• Triplanter: ₹720
• Hanging Planter: ₹390

🟤 SERVING/DÉCOR TRAYS
• Large Rectangular (16x8"): ₹720
• Square (9x9"): ₹468
• Round (13" diameter): ₹720
• Set of 3 Round Trays: ₹1200
• Shot Glass Tray: ₹680
• Cutlery Holder: ₹720

🟤 TABLEMATS
• All designs (12x18"): ₹250
• Natural/Striped/Chocochip/Olive

🟤 TRIVETS/HOT PLATES
• 7" Diameter (all finishes): ₹160
• Oval/Square (larger): ₹275
• Web Design: ₹200

🟤 BAGS & WALLETS
• Laptop Bag Granco/Linea: ₹1950-₹2450
• Laptop Sleeve: ₹650-₹750
• Conference Folder: ₹780
• Wallet Granco: ₹330
• Card Holder: ₹350
• Passport Holder: ₹360
• Pop-up Credit Card Wallet: ₹410

🟤 CLUTCHES & BAGS
• Clutch Purse (various prints): ₹850
• Designer Clutch: ₹1300
• Sling Bag (various prints): ₹980+

═══════════════════════════════════════
HORECA PRODUCTS (Hotel/Restaurant/Cafe)
═══════════════════════════════════════

TARGET: Hotels, Restaurants, Cafes, Bars, Resorts

🍽️ COASTERS (HORECA)
• Round/Square (100x5mm): ₹13
• Round/Square with Veneer: ₹18
• Hexagon with Veneer: ₹20
• Bread Coaster: ₹50
• Set of 4 Round with Case: ₹105
• Set of 6 Square with Case: ₹135

🍽️ TRIVETS (HORECA)
• Fine Natural/Olive/Chocochip: ₹160
• Square/Oval: ₹250
• Web Printed/Hexagon: ₹180

🍽️ TRAYS (HORECA)
• Large Rectangular (16x8"): ₹680
• Square (9x9"): ₹430
• Round (13" diameter): ₹680
• Large Chocochip (14x16"): ₹1150
• Heart Shaped: ₹1150
• Set of 3 Rectangular: ₹850

🍽️ PLACEMATS (HORECA)
• All designs (12x18"): ₹220
• Coffee Tablemat: ₹150

🍽️ BAR ACCESSORIES
• 2-Compartment Bar Caddy: ₹400
• 3-Compartment Bar Caddy: ₹850
• Multi-Compartment: ₹950
• Cutlery Holder: ₹850

🍽️ WINE CHILLERS
• Cylindrical Wine Chiller: ₹1500
• Barrel Small: ₹1800
• Barrel Large: ₹2200
• Vintage Ice Chiller: ₹2500-₹5500

🍽️ TISSUE BOXES & HOLDERS
• Tissue Box (all finishes): ₹350
• Tissue Holder: ₹170-₹250

🍽️ NAPKIN RINGS
• Round/Bow/Square (all designs): ₹63

🍽️ HORECA MISCELLANEOUS
• Menu & Payment Scanner: ₹280
• Reserve Tag: ₹175
• Bill Folder: ₹200
• Menu Folder: ₹450
• Reception Folder: ₹450
• Room Key Holder: ₹170
• Room Tag: ₹130
• Shot Glass Tray: ₹550-₹1200

🍽️ CORK LIGHTS (HORECA)
• Various Designs: ₹540-₹1600
• Hanging Lights: ₹400-₹1450

🍽️ CORK STOOLS & FURNITURE
• Stool Smoky Black: ₹5000
• Cylindrical Stool: ₹6500
• Coffee Table: ₹4500-₹5500

HORECA BENEFITS:
• Durable for daily commercial use
• Premium natural aesthetic
• Sustainable brand image
• Custom branding available
• Easy to maintain

HORECA PRICING:
• Min order: 100 pieces
• Volume discounts: 300+
• Custom branding included

═══════════════════════════════════════
CORPORATE GIFTING COMBOS (Ready Sets)
═══════════════════════════════════════

💼 BUDGET COMBOS (₹220-₹500)
• COMBO 11: A5 Diary + Metal Pen = ₹220
• COMBO 12: Printed Diary + Metal Pen = ₹325
• COMBO 13: A6 Diary + 4 Coasters + Seed Pen + 2 Tea Lights = ₹340
• COMBO 14: A5 Diary + 2 Coasters + Magnet Planter + Pen = ₹370
• COMBO 16: Magnet Planter Set of 3 = ₹440
• COMBO 17: Passport Holder + Keychain + Pen = ₹478

💼 MID-RANGE COMBOS (₹500-₹1000)
• COMBO 7: A5 Diary + Calendar + Keychain + Pen = ₹668
• COMBO 8: A5 Diary + Magnet Planter + 4 Coasters + Pen = ₹595
• COMBO 18: A5 Diary + 4 Coasters Case + Calendar + Keychain = ₹543
• COMBO 22: Desktop Mat + A5 Diary + 4 Coasters + Magnet Planter + Keychain = ₹728
• COMBO 5: A5 Diary + Desktop Organizer + Pen = ₹805
• COMBO 24: A5 Diary + Pouch + Bark Planter + Pen Holder + 2 Tea Lights = ₹845
• COMBO 25: Desktop Mat + A5 Diary + Calendar + Magnet Planter + Keychain + Pen = ₹853
• COMBO 9: A5 Diary + Calendar + Card Holder + Pen Stand = ₹995

💼 PREMIUM COMBOS (₹1000-₹1500)
• COMBO 6: Printed Pouch + Magnet Planter + Card Holder + 4 Coasters = ₹1020
• COMBO 30: A5 Diary + Desktop Organizer + Calendar + Bark Planter + Pen = ₹1050
• COMBO 10: iPad Organizer + Glass Bottle + Calendar = ₹1080
• COMBO 1: A5 Diary + Glass Bottle + Calendar + Card Holder + Pen = ₹1310
• COMBO 2: iPad Organizer + Glass Bottle + Passport Holder = ₹1280
• COMBO 3: Clock + Passport Holder + Desktop Organizer = ₹1380
• COMBO 35: Tray + Desktop Organizer + 4 Premium Coasters + Planter + 3 Tea Lights = ₹1425

💼 EXECUTIVE COMBOS (₹1500+)
• COMBO 4: A5 Diary + Clock + Card Holder + Passport Holder = ₹1570
• COMBO 36: Laptop Bag + A5 Diary + Keychain = ₹2045

🎁 OCCASIONAL/HOME GIFT COMBOS
• COMBO 37: 2 Bark Planters = ₹480
• COMBO 38: Square Tray + 4 Coasters + Magnet Planter + 2 Tea Lights = ₹670
• COMBO 40: Square Tray + 4 Coasters + Magnet Planter + 2 Tea Lights = ₹840
• COMBO 41: Square Tray + 4 Coasters + Tabletop Planter + 2 Tea Lights = ₹1030
• COMBO 42: Round Tray + 4 Coasters + Bark Planter + Tea Light = ₹1210
• COMBO 43: Large Tray + 4 Coasters + Bark Planter + 4-in-1 Tea Light = ₹1210
• COMBO 47: 4 Dining Mats + 2 Trivets + 4 Coasters + 2 Tea Lights = ₹1560

CUSTOM CORPORATE SOLUTIONS:
• Minimum: 50 sets
• Logo/branding included
• Custom packaging available
• Bulk discount: 15-25%
• Best for: Employee gifts, client appreciation, events, festivals, wedding favors

═══════════════════════════════════════
PRICING STRATEGY
═══════════════════════════════════════

**Retail (1-49):** Standard catalogue prices
**Bulk (50-99):** "Good volume discounts available"
**Corporate (100-299):** Wholesale + 20% discount
**Large Orders (300+):** "Special pricing - let me share quote"
**HORECA:** Custom commercial pricing

ALWAYS ASK QUANTITY FIRST before quoting prices!

═══════════════════════════════════════
CUSTOMER QUALIFICATION
═══════════════════════════════════════

🏠 RETAIL: Personal use/gift → individual items
🏢 CORPORATE: Company size/event → bulk, combos, branding
🍽️ HORECA: Hotel/Restaurant/Cafe → durability, branding, commercial use
🎁 GIFTING: Occasion/quantity → ready combos or custom

═══════════════════════════════════════
CONVERSATION STARTERS
═══════════════════════════════════════

**New Customer:**
"Hey! 👋 Welcome! We make sustainable cork products. What brings you here - personal use, corporate gifting, or for your business?"

**Corporate:**
"Hi! Great! Are you looking for employee gifts, client appreciation, or event giveaways? We have ready combos from ₹220 to ₹2000+ 🎁"

**HORECA:**
"Hello! We work with many hotels & restaurants. Looking for table settings, decor, or branded amenities? 🌿"

**Pricing Question:**
"Sure! Quick question - what quantity are you thinking? We have bulk discounts 😊"

**Sample Request:**
"Great idea! Which products - coasters, planters, organizers? We can arrange samples 👍"

═══════════════════════════════════════
COMMON Q&A
═══════════════════════════════════════

Q: "Is cork durable?"
A: "Absolutely! Cork lasts years, water-resistant, doesn't crack. Used in wine bottles for centuries! 💪"

Q: "Can you add logo?"
A: "Yes! Engraving/printing available for 50+ pieces. Perfect for branding. What quantity?"

Q: "MOQ?"
A: "No minimum for retail. For customization, 50-100 pieces. What are you looking for?"

Q: "Delivery?"
A: "7-10 days standard. 15-20 days for bulk/custom with branding. Deadline?"

Q: "Wedding favors?"
A: "Yes! Planters & coasters are super popular. We have combos from ₹340-₹1500. How many guests?"

═══════════════════════════════════════
RESPONSE RULES
═══════════════════════════════════════

1. Identify customer type FIRST
2. ASK quantity before exact pricing
3. Corporate/HORECA: emphasize bulk + customization
4. Retail: focus on sustainability + quality
5. Gifting: suggest combos with prices
6. Keep SHORT (2-3 sentences)
7. Qualify leads properly
8. Sound natural & conversational
9. Guide to next step: sample/quote/catalogue/call

REMEMBER: You KNOW all products, exact prices, and combos. Be confident! Qualify customers. This is WhatsApp - keep it SHORT!`;

// Test scenarios
const testScenarios = [
  {
    category: 'Greetings',
    message: 'Hi',
    expected: 'Warm greeting + ask about need (retail/corporate/HORECA)',
  },
  {
    category: 'Retail - Product Inquiry',
    message: 'Do you have cork coasters?',
    expected: 'Yes + ask quantity/use case',
  },
  {
    category: 'Retail - Personal Use',
    message: 'I need some coasters for my home',
    expected: 'Show options + ask quantity + mention designs',
  },
  {
    category: 'Corporate - Gifting Inquiry',
    message: 'We need corporate gifts for our employees',
    expected: 'Ask company size/quantity + suggest combos with price ranges',
  },
  {
    category: 'Corporate - Bulk Quantity',
    message: 'Need 200 diaries for company event',
    expected: 'Confirm bulk discount + ask about branding + timeline',
  },
  {
    category: 'Corporate - Budget Constraint',
    message: 'Budget ₹300-400 per person for 100 employees',
    expected: 'Suggest specific combos in that range (COMBO 13, 14, etc.)',
  },
  {
    category: 'HORECA - Restaurant',
    message: "We're opening a new restaurant and need table accessories",
    expected: 'Focus on HORECA products + ask about needs',
  },
  {
    category: 'HORECA - Hotel Bulk',
    message: 'How much for 500 coasters for our hotel?',
    expected: 'Quote HORECA pricing (₹13-20) + branding option',
  },
  {
    category: 'Pricing - Vague',
    message: 'What are your prices?',
    expected: 'Ask what products + quantity',
  },
  {
    category: 'Pricing - Specific',
    message: 'Price for Premium Square Fabric coasters?',
    expected: 'Ask quantity FIRST (retail vs bulk difference)',
  },
  {
    category: 'Sample Request',
    message: 'Can I get samples?',
    expected: 'Yes + ask which products + pricing/shipping',
  },
  {
    category: 'Product Quality',
    message: 'Will these coasters break easily?',
    expected: 'Reassure about durability + water-resistant',
  },
  {
    category: 'Customization',
    message: 'Can you add our company logo?',
    expected: 'Yes + 50-100 MOQ for customization + timeline',
  },
  {
    category: 'Delivery',
    message: 'Do you deliver to Mumbai?',
    expected: 'Yes + pan-India + timeline (7-10 days)',
  },
  {
    category: 'Wedding Favors',
    message: 'Looking for wedding return gifts for 150 guests',
    expected: 'Suggest planter/coaster combos + pricing (₹340-1500)',
  },
];

// Function to get AI response
async function getAIResponse(userMessage) {
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      temperature: 0.7,
      max_tokens: 500,
      top_p: 1,
      stream: false
    });

    return completion.choices[0]?.message?.content || "I'm here to help!";
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
}

// Rate response
function rateResponse(response, expected) {
  // Simple heuristic rating (can be improved)
  let score = 3; // Default okay score

  const responseLower = response.toLowerCase();

  // Check length (should be 2-3 sentences)
  const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length >= 2 && sentences.length <= 4) score += 0.5;
  if (sentences.length > 6) score -= 1; // Too long

  // Check for questions (qualifying)
  if (response.includes('?')) score += 0.5;

  // Check for emojis (but not too many)
  const emojiCount = (response.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount >= 1 && emojiCount <= 3) score += 0.5;
  if (emojiCount > 5) score -= 0.5;

  // Check if it's personalized
  if (responseLower.includes('priya') || responseLower.includes('hey') || responseLower.includes('hi')) score += 0.3;

  return Math.min(5, Math.max(1, score));
}

// Run tests
async function runTests() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     🧪 Batch AI Testing - Running Test Scenarios        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const results = [];
  let totalScore = 0;

  for (let i = 0; i < testScenarios.length; i++) {
    const test = testScenarios[i];
    console.log(`\n[${i + 1}/${testScenarios.length}] ${test.category}`);
    console.log(`─────────────────────────────────────────────────────────`);
    console.log(`📩 Message: "${test.message}"`);

    const response = await getAIResponse(test.message);
    const rating = rateResponse(response, test.expected);
    totalScore += rating;

    console.log(`🤖 Response: ${response}`);
    console.log(`📊 Expected: ${test.expected}`);
    console.log(`⭐ Rating: ${'⭐'.repeat(Math.round(rating))} (${rating.toFixed(1)}/5)`);

    results.push({
      ...test,
      response,
      rating
    });

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Summary
  const avgScore = totalScore / testScenarios.length;
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                    📊 TEST SUMMARY                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`Total Tests: ${testScenarios.length}`);
  console.log(`Average Score: ${avgScore.toFixed(2)}/5 ${'⭐'.repeat(Math.round(avgScore))}`);
  console.log(`\nScore Distribution:`);

  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  results.forEach(r => {
    const rounded = Math.round(r.rating);
    distribution[rounded]++;
  });

  for (let star = 5; star >= 1; star--) {
    const count = distribution[star];
    const bar = '█'.repeat(count);
    console.log(`  ${'⭐'.repeat(star)}: ${bar} (${count})`);
  }

  // Low-rated tests
  const lowRated = results.filter(r => r.rating < 3);
  if (lowRated.length > 0) {
    console.log(`\n\n🔴 Tests Needing Improvement (< 3 stars):`);
    lowRated.forEach((test, idx) => {
      console.log(`\n${idx + 1}. ${test.category}`);
      console.log(`   Message: "${test.message}"`);
      console.log(`   Rating: ${test.rating.toFixed(1)}/5`);
      console.log(`   Response: ${test.response.substring(0, 100)}...`);
    });
  }

  // High-rated tests
  const highRated = results.filter(r => r.rating >= 4);
  console.log(`\n\n🟢 Strong Performance (4+ stars): ${highRated.length}/${testScenarios.length}`);

  console.log('\n\n💡 Recommendations:');
  if (avgScore < 3) {
    console.log('   - Major prompt revision needed');
    console.log('   - Add more specific examples');
    console.log('   - Review response rules');
  } else if (avgScore < 4) {
    console.log('   - Good foundation, needs refinement');
    console.log('   - Focus on low-rated scenarios');
    console.log('   - Add more qualifying questions');
  } else {
    console.log('   - Excellent performance!');
    console.log('   - Fine-tune edge cases');
    console.log('   - Continue monitoring real conversations');
  }

  console.log('\n');
}

// Check for API key
if (!process.env.GROQ_API_KEY) {
  console.error('❌ Error: GROQ_API_KEY not found in .env file');
  process.exit(1);
}

// Run the tests
runTests().catch(console.error);
