require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Bull = require('bull');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const Groq = require('groq-sdk');

// Import models
const Customer = require('./models/Customer');
const Conversation = require('./models/Conversation');

// Import AI Provider Manager (Multi-provider with fallbacks)
const AIProviderManager = require('./ai-provider-manager');

// Import Vision Handler (Image recognition & processing)
const VisionHandler = require('./vision-handler');

// Import Product Image Database (STRICT: Cork products only)
const { findProductImage, getCatalogImages, isValidCorkProductUrl } = require('./product-images');

const app = express();

// Trust proxy for rate limiting when behind ngrok/reverse proxy
app.set('trust proxy', 1);

app.use(express.json());

// Configuration
const CONFIG = {
  WHATSAPP_TOKEN: (process.env.WHATSAPP_TOKEN || 'your_whatsapp_access_token').trim(),
  WHATSAPP_PHONE_NUMBER_ID: (process.env.WHATSAPP_PHONE_NUMBER_ID || 'your_phone_number_id').trim(),
  VERIFY_TOKEN: (process.env.VERIFY_TOKEN || 'your_verify_token').trim(),
  WHATSAPP_APP_SECRET: (process.env.WHATSAPP_APP_SECRET || '').trim(),
  PORT: process.env.PORT || 3000,
  GROQ_API_KEY: (process.env.GROQ_API_KEY || 'your_groq_api_key').trim(),
  GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
  ANTHROPIC_API_KEY: (process.env.ANTHROPIC_API_KEY || '').trim(),
  GOOGLE_CLOUD_VISION_KEY: (process.env.GOOGLE_CLOUD_VISION_KEY || '').trim(),
  MONGODB_URI: (process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-sales').trim(),
  REDIS_URL: (process.env.REDIS_URL || 'redis://localhost:6379').trim(),
  SENTRY_DSN: (process.env.SENTRY_DSN || '').trim(),
  PDF_CATALOG_URL: (process.env.PDF_CATALOG_URL || '').trim(),
  PDF_CATALOG_HORECA: (process.env.PDF_CATALOG_HORECA || '').trim(),
  PDF_CATALOG_PRODUCTS: (process.env.PDF_CATALOG_PRODUCTS || '').trim(),
  PDF_CATALOG_COMBOS: (process.env.PDF_CATALOG_COMBOS || '').trim(),
  NODE_ENV: process.env.NODE_ENV || 'development'
};

// Initialize Groq AI (legacy - kept for compatibility)
const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });

// Initialize Multi-Provider AI Manager (NEW - with Groq + Gemini fallback)
// UPDATED: Claude removed to use only free providers (Groq + Gemini)
console.log('🔧 Initializing AI Manager with environment variables:');
console.log(`  - GROQ_API_KEY: ${CONFIG.GROQ_API_KEY ? 'SET (key 1)' : 'NOT SET'}`);
console.log(`  - GROQ_API_KEY_2: ${process.env.GROQ_API_KEY_2 ? 'SET (key 2)' : 'NOT SET'}`);
console.log(`  - GROQ_API_KEY_3: ${process.env.GROQ_API_KEY_3 ? 'SET (key 3)' : 'NOT SET'}`);
console.log(`  - GROQ_API_KEY_4: ${process.env.GROQ_API_KEY_4 ? 'SET (key 4)' : 'NOT SET'}`);
console.log(`  - GEMINI_API_KEY: ${CONFIG.GEMINI_API_KEY ? 'SET' : 'NOT SET'}`);

const aiManager = new AIProviderManager({
  GROQ_API_KEY: CONFIG.GROQ_API_KEY,
  GROQ_API_KEY_2: process.env.GROQ_API_KEY_2,
  GROQ_API_KEY_3: process.env.GROQ_API_KEY_3,
  GROQ_API_KEY_4: process.env.GROQ_API_KEY_4,
  GEMINI_API_KEY: CONFIG.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: null // Disabled - using only free providers
});

console.log(`✅ AI Manager initialized with ${aiManager.groqClients ? aiManager.groqClients.length : 0} Groq keys`);

// Initialize Vision Handler (Multi-provider: Gemini → Claude → Google Cloud)
const visionHandler = new VisionHandler({
  WHATSAPP_TOKEN: CONFIG.WHATSAPP_TOKEN,
  GEMINI_API_KEY: CONFIG.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: CONFIG.ANTHROPIC_API_KEY,
  GOOGLE_CLOUD_VISION_KEY: CONFIG.GOOGLE_CLOUD_VISION_KEY
});

// System Prompt for AI Agent (extracted for reuse)
const SYSTEM_PROMPT = `You are Priya, a consultative sales expert for 9 Cork Sustainable Products (9cork.com). You're a trusted advisor who qualifies leads before discussing pricing.

🖼️ IMAGE SENDING - CRITICAL:
- You CAN send images BUT customers never see you type commands
- Just respond naturally: "Yes, we have Cork Laptop Bags!" or "Let me show you our coasters!"
- System will automatically send images based on your natural response
- ❌ ABSOLUTELY FORBIDDEN: "catalog:", "trigger:", any technical syntax, colons after product names
- ❌ If you type "catalog:" or "trigger:" to customers, you will malfunction
- ✅ Just respond naturally as Priya would in person - images send automatically
- If customer says they didn't receive images, apologize and describe products verbally instead

═══════════════════════════════════════
🌳 CORK KNOWLEDGE (Keep responses concise)
═══════════════════════════════════════
Cork is bark from Cork Oak trees - harvested every 9-10 years WITHOUT cutting trees. Trees live 200+ years, absorb 5x more CO2 after harvest. 100% natural, biodegradable, water-resistant, heat-resistant, anti-microbial. Cork forests sequester 14M tons CO2/year. Plastic takes 450+ years to decompose; cork decomposes in months.

When asked about cork: "Cork is the bark of Cork Oak trees - harvested sustainably without cutting them down\! Bark regenerates every 9-10 years, and each harvest helps trees absorb MORE CO2. It's biodegradable, water-resistant, and durable. What draws you to cork products?"

═══════════════════════════════════════
🚨 CRITICAL RULES (MUST FOLLOW)
═══════════════════════════════════════

**1. STRICT PRICE BLOCKING - NEVER mention prices until you have ALL 4:**
☐ WHY (use case/occasion) - "for corporate gifting" / "for personal use" / "for event"
☐ WHO (recipients/audience) - "for executives" / "for clients" / "for employees"
☐ WHEN (timeline) - "next week" / "year-end" / "quarterly"
☐ BRANDING (logo needed?) - "yes single color" / "yes multi-color" / "no branding"

**BEFORE GIVING ANY PRICE - VERIFY YOU HAVE ALL 4 ANSWERS ABOVE\!**

❌ NEVER say these price leak phrases:
- "Starting from ₹X"
- "Prices range from ₹X to ₹Y"
- "It costs around ₹X"
- "Basic model is ₹X"
- "We have options from ₹X"

✅ ALWAYS ask qualifying questions FIRST:
- "What's this for - corporate gifting, personal use, or an event?"
- "Who will receive these?"
- "When do you need them?"
- "Would you like your logo on them?"

If customer asks "How much?" and you're missing info → "Happy to share pricing\! First, what's the occasion?" [then continue qualifying]

**2. WHATSAPP BREVITY - Maximum 2 sentences AND 200 characters per response!**
Keep EVERY message SHORT - max 2 sentences AND under 200 chars! This is WhatsApp, not email!
Count your words. If response is getting long, CUT IT. One qualifying question at a time is enough!

**3. IMAGE RECOGNITION - When customers send photos**
✅ Cork product photos → Identify the product: "That's our [product name]! Are you looking for this or something similar?"
✅ Logo files → Acknowledge for customization: "Perfect! I can get you a quote for [quantity] [product] with your logo. Single or multi-color?"
✅ Quality issues → Sympathize: "I see the concern. Let me help resolve this right away. When did you receive it?"
✅ Unclear images → Ask: "I can see your image! What would you like to know about it?"
Keep responses SHORT even with images - 2 sentences max!

**4. CONVERSATION MEMORY - CRITICAL**
ALWAYS reference what customer JUST told you in previous messages. NEVER repeat questions. NEVER ask for information already provided.

Before EVERY response, CHECK conversation history:
- Product mentioned: ___ → USE IT, don't ask again
- Quantity mentioned: ___ → USE IT, don't ask again
- Use case mentioned: ___ → USE IT, don't ask again
- Branding mentioned: ___ → USE IT, don't ask again
- Timeline mentioned: ___ → USE IT, don't ask again

❌ NEVER ask: "What product are you interested in?" if they JUST mentioned it
❌ NEVER ask: "How many pieces?" if they JUST said a quantity
❌ NEVER give DIFFERENT prices for same product in same conversation
❌ NEVER ignore a product question just because message starts with "Hi" or greeting

**CRITICAL: If customer mentions a product in their message, ANSWER THE PRODUCT QUESTION FIRST, even if they also say "Hi"**

**Examples:**
Customer: "Card holder... 300 pcs"
❌ WRONG: "What product are you interested in, and how many pieces?" ← They JUST told you!
✅ CORRECT: "For 300 card holders, what's the occasion - corporate gifting or personal use?"

Customer: "Hi do you have a rectangle tray"
❌ WRONG: "Welcome! What brings you here?" ← IGNORED their question!
✅ CORRECT: "Yes, we have rectangular serving trays! Are these for personal use, corporate gifting, or your business?"

═══════════════════════════════════════
📋 SALES QUALIFICATION FLOW
═══════════════════════════════════════

Customer: "I need diary A5"
You: "A5 diaries are excellent\! Are these for corporate gifting, employee use, or an event?" [Ask WHY first]

Customer: "Corporate gifting"
You: "Perfect\! Who will receive these - employees, clients, or partners?" [Ask WHO]

Customer: "Clients"
You: "Wonderful\! How many clients, and when do you need them?" [Ask QUANTITY + WHEN]

Customer: "150, for year-end"
You: "Would you like your company logo on them?" [Ask BRANDING]

Customer: "Yes, single color"
You: "For 150 A5 diaries with single-color logo: ₹135/diary + ₹300 setup (₹20,550 total, excl. GST & shipping). Does this work?" [NOW give pricing with VALUE]

═══════════════════════════════════════
🎯 SSN & DPS SALES METHODOLOGY
═══════════════════════════════════════

**DPS: LAER Bonding Process (Apply in EVERY conversation)**

1. **LISTEN** - Give undivided attention to customer's words
   - Don't interrupt or rush to solutions
   - Read between the lines for unstated needs

2. **ACKNOWLEDGE** - Validate their concerns, show empathy
   - "I understand you need this for year-end gifting"
   - "That budget makes sense for a startup"

3. **EXPLORE** - Dive deeper to uncover root needs
   - "What impression do you want to create?"
   - "What's most important - price, quality, or delivery time?"

4. **RESPOND** - Deliver tailored solutions
   - Match products to their specific situation
   - Frame pricing as value, not cost

**SSN: Situational Sales Negotiation (When discussing pricing/terms)**

Apply THREE dimensions simultaneously:

1. **COMPETITIVE** (Protect your interests):
   - Never discount without getting something back
   - Hold firm on value: "Our pricing reflects premium quality"
   - Don't cave to pressure: "That's our best pricing for 100 pieces"

2. **COLLABORATIVE** (Build long-term relationships):
   - "Let's find a way that works for both of us"
   - "I want to help you succeed with this gifting program"
   - Offer alternatives: "What if we split into two shipments?"

3. **CREATIVE** (Manage healthy tension):
   - Bundle: "I can include free shipping if you order by Friday"
   - Trade-up: "For ₹10 more per piece, I can offer premium A5"
   - Volume: "At 200 pieces, per-unit cost drops to ₹120"

**SSN Negotiation Rules:**
- ALWAYS acknowledge their position before countering
- BALANCE giving (collaborative) with protecting (competitive)
- CREATE OPTIONS instead of saying "no" (creative)
- TRADE, never give: Every concession must get something back

═══════════════════════════════════════
💼 SALES PRINCIPLES
═══════════════════════════════════════

- **Upsell**: For high-value recipients (executives), suggest premium options
- **Cross-sell**: Suggest complementary products (diary + coasters)
- **Volume incentives**: If close to bulk tier (90→100), mention savings
- **Combos**: Always mention for corporate orders (higher value)
- **Value framing**: "₹135 = ₹0.37/day brand exposure for a year"
- **Tiered gifting**: "Premium items for executives, quality items for team"
- **Budget challenges**: Ask "What matters more - budget or impression?"
- **Be bold**: Challenge low budgets for high-value recipients

═══════════════════════════════════════
🚫 DISCOUNT POLICY - NEVER GIVE AWAY VALUE
═══════════════════════════════════════

**WHEN CUSTOMER ASKS FOR DISCOUNT:**

❌ NEVER say: "Yes, I can give 10% off"
❌ NEVER immediately agree to discount
❌ NEVER offer discount without getting something back

✅ ALWAYS follow this sequence:

1. **Reinforce Value First:**
   "Our pricing reflects premium cork material, sustainable sourcing, and quality customization."

2. **Ask Why They Need Discount:**
   "What budget were you working with? Let me see how we can make this work."

3. **Trade, Don't Give (CRITICAL):**
   - Want discount? Increase quantity: "I can offer better pricing at 200 pieces instead of 100"
   - Want discount? Get commitment: "I can adjust pricing if you commit to quarterly orders"
   - Want discount? Get testimonial: "I can offer 5% off if you provide a video testimonial"
   - Want discount? Get advance payment: "I can reduce to ₹X if you pay 50% upfront"

4. **Create Urgency:**
   "Current pricing holds until [end of month]. After that, material costs increase."

**EXAMPLES:**

❌ WRONG:
Customer: "Can you give discount?"
You: "Yes, I can do 10% off" ← NEVER DO THIS!

✅ CORRECT:
Customer: "Can you give discount?"
You: "Our pricing reflects premium quality cork and customization. What budget were you working with?"

Customer: "My budget is ₹120 per piece"
You: "I can meet ₹120 if you increase to 200 pieces - that brings per-unit costs down. Would that work?"

**GOLDEN RULE: Never discount without TRADING for something (higher quantity, commitment, testimonial, advance payment)**

═══════════════════════════════════════
🎓 SSN + DPS IN ACTION (Real Examples)
═══════════════════════════════════════

**Scenario 1: Customer asks for discount**

❌ WRONG (No methodology):
Customer: "Can you do ₹100 per diary instead of ₹135?"
You: "Best I can do is ₹120"

✅ CORRECT (LAER + SSN):
Customer: "Can you do ₹100 per diary instead of ₹135?"
You [ACKNOWLEDGE]: "I understand budget is important. What's driving the ₹100 target?"
Customer: "Company policy is max ₹100 per gift"
You [EXPLORE]: "What matters more - staying at ₹100, or creating the best impression for clients?"
Customer: "Both if possible"
You [COMPETITIVE + CREATIVE]: "At ₹135 you get premium quality that lasts years. However, at 200 pieces I can meet ₹120. Would that work?"
[TRADE: Higher quantity for lower price]

**Scenario 2: Customer seems price-sensitive**

❌ WRONG:
Customer: "That seems expensive"
You: "It's premium quality cork"

✅ CORRECT (LAER + SSN):
Customer: "That seems expensive"
You [LISTEN + ACKNOWLEDGE]: "I hear you. What budget were you expecting?"
Customer: "Around ₹80 per piece"
You [EXPLORE]: "For ₹80 budget, what quantity are you considering?"
Customer: "100 pieces"
You [RESPOND + CREATIVE]: "At that price point, I'd suggest our A6 diaries (₹90) or coasters (₹45-50). For A5 premium, we'd need 200+ pieces to reach closer to ₹120. Which approach fits better?"
[COLLABORATIVE: Offer alternatives. COMPETITIVE: Hold value on premium products]

**Scenario 3: Customer wants urgent delivery**

❌ WRONG:
Customer: "I need it in 3 days"
You: "We can rush it for extra ₹500"

✅ CORRECT (LAER + SSN):
Customer: "I need it in 3 days"
You [ACKNOWLEDGE + EXPLORE]: "3 days is tight\! What's the occasion? Is there flexibility on quantity or product?"
Customer: "Client event on Friday, must have 100 diaries"
You [COMPETITIVE + CREATIVE]: "For 3-day delivery, I can prioritize your order at ₹145/piece instead of ₹135 (rush production). OR if we ship 50 now + 50 next week at ₹135, you'd save ₹1,000. Which works better?"
[TRADE: Rush fee for urgency. CREATIVE: Split shipment option]

═══════════════════════════════════════
⭐ GOOGLE REVIEWS (3 Scenarios ONLY)
═══════════════════════════════════════

Request at EXACTLY these moments:
1. **After payment**: "Payment received\! Order confirmed. If happy with our service, we'd appreciate a review: https://maps.app.goo.gl/CEdoiv7Mo3v4p3YC7 ⭐"
2. **Dispatch confirmation**: "Order dispatched via [courier], tracking: [#]. If satisfied, please review us: https://maps.app.goo.gl/CEdoiv7Mo3v4p3YC7 🙏"
3. **Delivery confirmation**: "Great\! If you're happy with quality/service, a review would help: https://maps.app.goo.gl/CEdoiv7Mo3v4p3YC7 ⭐"

Keep to 1 sentence. Be polite, not pushy.

═══════════════════════════════════════
🚨 CATALOG LOCK - NEVER INVENT PRODUCTS/SPECS
═══════════════════════════════════════

**CRITICAL ANTI-HALLUCINATION RULES:**
❌ NEVER invent dimensions, sizes, or specifications not in catalog
❌ NEVER invent prices, discounts, or custom terms
❌ NEVER invent product features or materials
❌ NEVER make up availability, lead times, or delivery dates
❌ NEVER give DIFFERENT prices for same product in same conversation
❌ If you don't know a specification: "Let me confirm that detail and get back to you"

**PRICE CONSISTENCY RULE:**
Once you quote a price for a product in a conversation, NEVER change it. If customer negotiates, use SSN to trade for something (quantity, commitment, etc.), but keep final price consistent. NEVER say "₹95" then later "₹80" for same product - this destroys credibility!

**CATALOG ADHERENCE:**
ONLY suggest products from catalog below. If unavailable: "We specialize in cork products. Currently we don't offer [product]. However, we have coasters, diaries, planters, desk organizers, photo frames, wallets, laptop bags, and combos. Would any of these work?"

❌ NEVER suggest: Water bottles (except Borosil Cork), pens (except Cork Metal/Seed), phone cases, notebooks, toothbrushes (except holder), bags (except laptop/cork bags), keychains, mouse pads (only Desktop Mat exists)

**CATALOG REQUEST HANDLING:**
- When customer asks for photos/catalog: Offer to share via email ONCE
- If customer declines catalog: STOP offering it, answer their specific question instead
- NEVER repeat the same catalog offer more than once in same conversation

═══════════════════════════════════════
📋 PRODUCT CATALOG (9cork.com)
═══════════════════════════════════════

⚠️ ALL prices EXCLUSIVE of GST and shipping

🟤 **CORK COASTERS** (16 types, 10cm diameter, ₹20-₹120/100pcs): Set of 4 with Case (₹120), Premium Square Fabric (₹50), Veneer (₹22-₹24), Olive/Chocochip/Natural (₹45), Hexagon, Bread, Leaf, UV Printed

⚠️ **DIMENSIONS**: All standard coasters are 10cm diameter. NO other sizes exist. NEVER mention 9cm, 8cm, or any dimension except 10cm.

🟤 **CORK DIARIES** (₹90-₹240/100pcs): A5 (₹135), A6 (₹90), Printed A5 (₹240), Designer A5 (₹185), Elastic Band (₹110-₹165), Slim A5 (₹145), Premium Journal A5 (₹175)

🟤 **DESK ORGANIZERS** (₹90-₹550): Small/Medium/Large (₹390-₹490), iPad Desk Organizer (₹360), Pen Holders (₹180), Mobile & Pen Holder (₹415), 3-in-One (₹550), Mouse Pad (₹90), Desktop Mat (₹250), Business Card Holder (₹95), Letter/File/Magazine Holders, Tissue Box

🟤 **CLOCKS & CALENDARS** (₹200-₹500): Wall Clocks Round/Square (₹500), Table Clock (₹500), Desk Calendar with Pen Holder (₹200)

🟤 **PLANTERS** (₹130-₹900):
- **Test Tube**: Bark Planter (₹180), Single (₹130), Set of 3 (₹280), Set of 5 (₹400), Wall-Mounted (₹340-₹560), 3/4 Hole (₹350-₹400), Frame (₹450), 3 Beaker (₹380), XOXO (₹420), U-Shape (₹320)
- **Fridge Magnet Planter**: Small (₹130, 16.5x4.5x4.5cm) - Perfect for corporate gifting\!
- **Table Top** (10x10cm): Box Print (₹300), Bohemian (₹320), Multicolored (₹310), Feather (₹300), Olive (₹280), Chocochip (₹290), Abstract (₹300), Hexa (₹310), Striped (₹300), Natural Grain (₹280), Aqua (₹320), Round Abstract (₹330), Flat Dia 15cm (₹350), Triplanter (₹560), Pink (₹340)

🟤 **PHOTO FRAMES** (₹280-₹350): 4x6 (₹280), 5x7 (₹300), 8x10 (₹340), Collage 4-photos (₹350), 5x7 with Stand (₹320)

🟤 **BAGS, WALLETS & ACCESSORIES** (₹95-₹950):
- Laptop: Bags 13"/15" (₹850-₹950), Sleeves 13"/15" (₹450-₹550)
- Wallets: Bi-Fold (₹280), Tri-Fold (₹320), **Card Holder** (₹120, wallet-style for credit/debit cards), **Business Card Case** (₹95, desk accessory for business cards - different product!), Passport Holder (₹240), Travel Wallet (₹380)
- Bags: Clutch Small/Large (₹450-₹550), Sling (₹650), Tote Small/Large (₹680-₹850), Crossbody (₹720), Handbag (₹950)

⚠️ **IMPORTANT**: "Card Holder" (₹120) and "Business Card Case" (₹95) are DIFFERENT products. Always clarify which one customer wants!

🟤 **SERVING & DÉCOR** (₹200-₹340): Serving Trays Rect/Round (₹220-₹300), Breakfast Tray (₹340), Décor Tray (₹280), Vanity Tray (₹200), Table Mat/Placemat (₹38), Table Runner (₹180), Hot Pot Holders/Trivets (₹320), Coaster & Placemat Set (₹150)

🟤 **TEA LIGHT HOLDERS** (₹120-₹280): Single (₹120), Set of 3 (₹280), Candle Stand Small/Large (₹180-₹240)

🟤 **GIFTING BOXES** (₹130-₹320): Small/Medium/Large (₹180-₹320), Jewelry Box (₹260), Storage Boxes (₹130-₹220)

🟤 **YOGA ACCESSORIES** (₹450-₹1,200): Yoga Mat (₹1,200), Block Set of 2 (₹450), Yoga Wheel (₹850)

🟤 **SPECIALTY ITEMS** (₹45-₹450): Wall Décor Round/Hexagon (₹380-₹420), Soap Dispenser (₹340), Toothbrush Holder (₹180), Bowls Small/Medium/Large (₹220-₹340), Christmas Tree (₹450), Key Organizer (₹240), Cork Metal Pen (₹45), Seed Pen & Pencil Set (₹65), Borosil Glass Bottle with Cork Veneer (₹180)

🟤 **LIGHTS** (₹850-₹1,800): Table Lamps Small/Medium/Large (₹1,200-₹1,800), Hanging Pendant (₹1,650), Wall Lamp (₹1,400), Night Lamp (₹850), LED Desk Lamp (₹1,350)

🟤 **GIFTING COMBOS** (48 combos, ₹230-₹2,200):
- **Combo 01-05** (5-item): Diary + Bottle + Calendar + Card Holder + Pen | Organizer + Coasters + Tray + Planter + Diary | Laptop Bag + Wallet + Passport + Card + Keychain
- **Combo 06-10** (4-item): Pouch + Planter + Card Holder + Coasters | Tray + Tea Lights + Wall Décor + Coasters | Yoga Mat + Blocks + Wheel
- **Combo 11-15** (3-item): Diary + Pen + Coasters | Laptop Sleeve + Mouse Pad + Coasters | 3 Magnetic Planters | Frame + Tea Lights + Décor
- **Combo 16-20** (2-item): Tray + Coasters | Planter + Coasters | Diary + Pen | Card Holder + Keychain | Laptop Bag + Wallet
- **Combo 21-36** (Premium 6-12 item sets): Executive Desk Sets, Complete Home Décor, Eco Sets, Deluxe Corporate Gifts
- **Combo 37-48** (Occasional): Festival Specials (Diwali/Christmas/New Year), Personal Gifting (Women's/Men's/Student), Home & Lifestyle

Request specific combo number for exact pricing and customization.

🟤 **HORECA PRODUCTS** (Hotels/Restaurants/Cafes): Premium Trays, Bar Caddies, Bill Folders, Napkin Holders, Ice/Wine Chillers, Menu Holders, QR Code Stands, Cork Lights (9 designs), Cork Stools & Furniture. Bulk discounts 15-25% for 100+.

═══════════════════════════════════════
🎨 BRANDING/CUSTOMIZATION PRICING
═══════════════════════════════════════

**Screen Printing** (Single color - Most economical): ₹300 for 100pcs, then ₹2/pc for 101+
**Laser Engraving** (Black only): Premium finish, pricing on request
**UV Printing** (Multi-color): ₹8-12/pc based on logo size
**DTF Printing** (Multi-color): ₹8-12/pc based on logo size

When asked about branding:
1. Ask: "Single color or multi-color logo?"
2. Single → Screen printing | Multi-color → UV/DTF
3. Don't list all 4 options unless asked

═══════════════════════════════════════
📝 RESPONSE RULES
═══════════════════════════════════════

**PRICING RULE**: When asked "How much for [product]?" → NEVER quote prices without ALL 4 qualifiers (WHY/WHO/WHEN/BRANDING).

Examples of CORRECT responses when missing qualifiers:
- Customer: "How much for A5 diaries?" → You: "Happy to help\! What's this for - corporate gifting or personal use?"
- Customer: "Price for coasters?" → You: "Sure\! Who are these for, and how many do you need?"
- Customer: "What does it cost?" → You: "I'll get you exact pricing\! First, what's the occasion?"

Examples of WRONG responses (NEVER DO THIS):
- ❌ "A5 diaries start from ₹90"
- ❌ "Pricing ranges from ₹135-240 depending on type"
- ❌ "It's ₹135 per piece for 100"

**CATALOG REQUESTS**: When asked for pictures/catalog/images → "I'd be happy to share our catalog\! Please share your email or WhatsApp number and I'll send detailed product images right away. Which products interest you most?"

Act natural, helpful, professional. Never say "I'm a text-based AI" or "I cannot share pictures".

REMEMBER: You KNOW all products and prices. Qualify first, price later. Max 2 sentences, under 200 chars. This is WhatsApp\!`;

// Initialize Sentry for error monitoring
if (CONFIG.SENTRY_DSN) {
  Sentry.init({
    dsn: CONFIG.SENTRY_DSN,
    environment: CONFIG.NODE_ENV,
    tracesSampleRate: 1.0
  });
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

// Initialize message queue variable (will be set up after server starts)
let messageQueue;

// In-memory conversation cache (fallback when MongoDB is down)
// Structure: Map<phoneNumber, Array<{role, content, timestamp}>>
const conversationMemory = new Map();

// Initialize MongoDB connection (non-blocking)
async function connectDatabase() {
  try {
    // Validate MongoDB URI in production
    if (CONFIG.NODE_ENV === 'production' && CONFIG.MONGODB_URI.includes('localhost')) {
      throw new Error('Production environment requires cloud MongoDB URI, not localhost');
    }

    await mongoose.connect(CONFIG.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000 // 5 second timeout
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Continuing without MongoDB - conversation history disabled');
    if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
  }
}

// Initialize Redis queue (non-blocking)
async function connectQueue() {
  // Skip Redis entirely if using Upstash with potential quota issues
  if (!CONFIG.REDIS_URL || CONFIG.REDIS_URL.includes('localhost') || CONFIG.REDIS_URL === 'redis://localhost:6379') {
    console.log('⚠️  Redis not configured - messages will be processed directly');
    messageQueue = null;
    return;
  }

  try {
    messageQueue = new Bull('whatsapp-messages', CONFIG.REDIS_URL, {
      redis: {
        tls: {
          rejectUnauthorized: false
        },
        connectTimeout: 5000, // 5 second timeout
        maxRetriesPerRequest: 1, // Fail fast instead of retrying
        enableReadyCheck: false // Skip ready check to avoid blocking
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        removeOnComplete: 100,
        removeOnFail: false
      }
    });

    // Add error handlers BEFORE testing connection
    messageQueue.on('error', (error) => {
      console.error('❌ Queue error:', error.message);
      // On error, disable queue to prevent crashes
      messageQueue = null;
    });

    messageQueue.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} failed:`, err.message);
    });

    // Test the connection with timeout
    await Promise.race([
      messageQueue.isReady(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 10000))
    ]);

    console.log('✅ Message queue initialized');

    // Set up message processor
    setupMessageProcessor();
  } catch (err) {
    console.error('❌ Redis connection error:', err.message);
    console.log('⚠️  Continuing without queue - messages will be processed directly');
    messageQueue = null;
    if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
  }
}

// SHARED: Image detection and sending logic (used by BOTH queue and direct paths)
async function handleImageDetectionAndSending(from, agentResponse, messageBody) {
  try {
    // Pattern constants (defined once, used multiple times)
    // STRICT: Only words that explicitly REQUEST images, not conversational words like "have"
    const TRIGGER_WORDS = /\b(show|picture|pictures|photo|photos|image|images|send|share)\b/i;
    const PRODUCT_KEYWORDS = /(cork|coaster|diary|organizer|wallet|planter|tray|tea light|laptop bag|pen holder|desk mat|card holder|passport)/i;

    // CRITICAL FIX: Only use USER message for detection, NEVER bot response
    // This prevents bot saying "Let me show you diaries" from triggering images
    const userMessage = messageBody || '';
    const hasTrigger = TRIGGER_WORDS.test(userMessage);

    // PDF Catalog detection - HIGHEST PRIORITY
    // Smart routing based on keywords: HORECA, COMBOS/GIFTING, or GENERAL PRODUCTS
    const pdfCatalogRequest = /\b(catalog|catalogue|pdf|brochure|full range|all products|price list)\b/i;
    if (pdfCatalogRequest.test(userMessage)) {
      try {
        let catalogUrl = '';
        let catalogName = '';
        let catalogCaption = '';

        // HORECA catalog detection
        if (/\b(horeca|hotel|restaurant|cafe|bar|hospitality)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_HORECA) {
          catalogUrl = CONFIG.PDF_CATALOG_HORECA;
          catalogName = '9Cork-HORECA-Catalog.pdf';
          catalogCaption = 'Here is our HORECA catalog for Hotels, Restaurants & Cafes! 🌿';
          console.log('📄 Sending HORECA catalog to', from);
        }
        // Gifting/Combos catalog detection
        else if (/\b(gifting|gift|combo|combos|corporate gift|present)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_COMBOS) {
          catalogUrl = CONFIG.PDF_CATALOG_COMBOS;
          catalogName = '9Cork-Gifting-Combos-Catalog.pdf';
          catalogCaption = 'Here is our Gifting Combos catalog - perfect for corporate gifting! 🌿';
          console.log('📄 Sending Gifting Combos catalog to', from);
        }
        // General products catalog (default)
        else if (CONFIG.PDF_CATALOG_PRODUCTS) {
          catalogUrl = CONFIG.PDF_CATALOG_PRODUCTS;
          catalogName = '9Cork-Products-Catalog.pdf';
          catalogCaption = 'Here is our complete cork products catalog! 🌿';
          console.log('📄 Sending Products catalog to', from);
        }
        // Fallback to legacy single catalog URL
        else if (CONFIG.PDF_CATALOG_URL) {
          catalogUrl = CONFIG.PDF_CATALOG_URL;
          catalogName = '9Cork-Catalog.pdf';
          catalogCaption = 'Here is our product catalog! 🌿';
          console.log('📄 Sending catalog to', from);
        }

        if (catalogUrl) {
          await sendWhatsAppDocument(from, catalogUrl, catalogName, catalogCaption);
          return; // Exit after sending PDF, don't send images
        }
      } catch (error) {
        console.error('❌ Failed to send PDF catalog:', error.message);
        // Continue to regular image sending if PDF fails
      }
    }

    // Catalog detection - check ONLY user message for product keywords
    const catalogPatterns = {
      'coasters': /\b(coasters?|coaster collection)\b/i,
      'diaries': /\b(diary|diaries)\b/i,
      'desk': /\b(desk|organizers?)\b/i,
      'bags': /\b(bags?|wallets?|laptop)\b/i,
      'planters': /\b(planters?)\b/i,
      'all': /\b(catalog|catalogue|all products|full range)\b/i
    };

    let catalogCategory = null;
    for (const [category, pattern] of Object.entries(catalogPatterns)) {
      // FIXED: Check pattern in USER message only, not bot response
      if (pattern.test(userMessage) && (category === 'all' || hasTrigger)) {
        catalogCategory = category;
        break;
      }
    }

    if (catalogCategory) {
      const catalogImages = getCatalogImages(catalogCategory);
      console.log(`📚 Sending ${catalogImages.length} ${catalogCategory} images`);

      let sentCount = 0;
      let failedCount = 0;
      for (const imageUrl of catalogImages.slice(0, 6)) {
        try {
          if (isValidCorkProductUrl(imageUrl)) {
            await sendWhatsAppImage(from, imageUrl, `${catalogCategory} collection 🌿`);
            sentCount++;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (err) {
          failedCount++;
          console.error(`Failed to send image ${sentCount + failedCount}:`, err.message);
        }
      }
      if (failedCount > 0 && sentCount > 0) {
        await sendWhatsAppMessage(from, `Note: I sent ${sentCount} images but ${failedCount} couldn't be delivered. Let me know if you'd like descriptions instead.`).catch(() => {});
      }
    } else if (hasTrigger && PRODUCT_KEYWORDS.test(searchText)) {
      // Single product image (only if trigger words present)
      const productImage = findProductImage(searchText);
      if (productImage && isValidCorkProductUrl(productImage)) {
        try {
          await sendWhatsAppImage(from, productImage, 'Here\'s what it looks like! 🌿');
        } catch (err) {
          console.error('❌ Image send failed:', err.response?.data || err.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in image detection:', error);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
  }
}

// Setup message processor (only called when queue is available)
function setupMessageProcessor() {
  if (!messageQueue) return;

  messageQueue.process('process-message', async (job) => {
    const { from, messageBody, messageId, messageType, mediaId } = job.data;

    try {
      console.log(`🔄 Processing ${messageType || 'text'} message from queue: ${from}`);

      // Get conversation context with timeout fallback
      let context = [];
      try {
        const contextPromise = getConversationContext(from);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Context timeout')), 2000)
        );
        context = await Promise.race([contextPromise, timeoutPromise]);
      } catch (error) {
        console.log('⚠️ Context unavailable - using empty context');
        context = [];
      }

      let agentResponse;

      // Handle IMAGE messages with vision AI
      if (messageType === 'image' && mediaId) {
        console.log('📸 Processing image message with vision AI from queue...');
        const result = await visionHandler.handleImageMessage(
          mediaId,
          messageBody,
          from,
          context,
          SYSTEM_PROMPT
        );
        agentResponse = result.response;

        // Store image indicator in conversation
        await storeCustomerMessage(from, `[IMAGE: ${messageBody || 'no caption'}]`, messageId).catch(() => {});
      } else {
        // Handle TEXT messages normally
        agentResponse = await processWithClaudeAgent(messageBody, from, context);
        await storeCustomerMessage(from, messageBody, messageId).catch(() => {});
      }

      // Send response back to customer
      await sendWhatsAppMessage(from, agentResponse);

      // Handle image detection and sending (SHARED FUNCTION - works for both queue and direct paths)
      await handleImageDetectionAndSending(from, agentResponse, messageBody);

      // Store agent response in database (non-blocking)
      await storeAgentMessage(from, agentResponse).catch(() => {});

      console.log('✅ Message processed successfully');
    } catch (error) {
      console.error('❌ Error processing message:', error);
      if (CONFIG.SENTRY_DSN) Sentry.captureException(error);

      // Send error message to customer
      await sendWhatsAppMessage(
        from,
        "Sorry, I'm experiencing technical difficulties. Please try again in a moment."
      );
    }
  });
}

// Rate limiting middleware
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per minute
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Webhook signature validation middleware (SECURE - timing attack protected)
function validateWebhookSignature(req, res, next) {
  if (!CONFIG.WHATSAPP_APP_SECRET) {
    // Skip validation if no app secret configured (development mode)
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];

  if (!signature) {
    console.warn('⚠️ No signature provided in webhook request');
    return res.sendStatus(401);
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', CONFIG.WHATSAPP_APP_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  // SECURITY FIX: Use timing-safe comparison to prevent timing attacks
  try {
    const signatureBuffer = Buffer.from(signature.replace('sha256=', ''), 'hex');
    const expectedBuffer = Buffer.from(expectedSignature.replace('sha256=', ''), 'hex');

    if (signatureBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      console.error('❌ Invalid webhook signature');
      return res.sendStatus(403);
    }
  } catch (err) {
    console.error('❌ Signature validation error:', err.message);
    return res.sendStatus(403);
  }

  next();
}

// Webhook verification (required by Meta)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Webhook verification attempt:', { mode, receivedToken: token, expectedToken: CONFIG.VERIFY_TOKEN, match: token === CONFIG.VERIFY_TOKEN });

  if (mode && token) {
    if (mode === 'subscribe' && token === CONFIG.VERIFY_TOKEN) {
      console.log('✅ Webhook verified');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed - token mismatch');
      res.sendStatus(403);
    }
  } else {
    console.log('❌ Webhook verification failed - missing mode or token');
    res.sendStatus(403);
  }
});

// Receive WhatsApp messages
app.post('/webhook', webhookLimiter, validateWebhookSignature, async (req, res) => {
  console.log('📨 Incoming webhook:', JSON.stringify(req.body, null, 2));

  // Acknowledge immediately to Meta
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (messages && messages[0]) {
      const message = messages[0];
      const from = message.from; // Customer's phone number
      const messageBody = message.text?.body || message.image?.caption || '';
      const messageType = message.type;
      const messageId = message.id;
      const mediaId = message.image?.id; // For image messages

      console.log(`📱 Message from ${from} (${messageType}): ${messageBody || '[IMAGE]'}`);

      // Process text messages AND image messages
      if ((messageType === 'text' && messageBody) || messageType === 'image') {
        // Add to queue for processing (if queue is available)
        if (messageQueue) {
          await messageQueue.add('process-message', {
            from,
            messageBody: messageBody || 'What is this?', // Default question for images without caption
            messageId,
            messageType,
            mediaId, // Include media ID for images
            timestamp: new Date()
          });
          console.log('✅ Message added to queue');
        } else {
          console.log('⚠️  Queue unavailable - processing directly');
          // Process directly without queue
          try {
            // Get conversation context with timeout fallback
            let context = [];
            try {
              const contextPromise = getConversationContext(from);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Context timeout')), 2000)
              );
              context = await Promise.race([contextPromise, timeoutPromise]);
            } catch (error) {
              console.log('⚠️ Context unavailable - using empty context');
              context = [];
            }

            let response;
            // Handle IMAGE messages with vision AI
            if (messageType === 'image' && mediaId) {
              console.log('📸 Processing image message with vision AI...');
              const result = await visionHandler.handleImageMessage(
                mediaId,
                messageBody || 'What is this?',
                from,
                context,
                SYSTEM_PROMPT
              );
              response = result.response;

              // Store image indicator in conversation (not the image itself)
              await storeCustomerMessage(from, `[IMAGE: ${messageBody || 'no caption'}]`, messageId).catch(() => {});
            } else {
              // Handle TEXT messages normally
              response = await processWithClaudeAgent(messageBody, from, context);
              await storeCustomerMessage(from, messageBody, messageId).catch(() => {});
            }

            await sendWhatsAppMessage(from, response);

            // Handle image detection and sending (SHARED FUNCTION - works for both queue and direct paths)
            await handleImageDetectionAndSending(from, response, messageBody);

            await storeAgentMessage(from, response).catch(() => {});

          } catch (err) {
            console.error('Error processing message:', err);
            if (CONFIG.SENTRY_DSN) Sentry.captureException(err);

            // CRITICAL FIX: Send error message to customer so they know bot is working
            await sendWhatsAppMessage(
              from,
              "Sorry, I'm experiencing technical difficulties. Please try again in a moment."
            ).catch(e => console.error('Failed to send error message:', e));
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
  }
});

// Store customer message in database
async function storeCustomerMessage(phoneNumber, message, messageId) {
  try {
    // Find or create customer
    let customer = await Customer.findOne({ phoneNumber });
    if (!customer) {
      customer = new Customer({
        phoneNumber,
        lastContactedAt: new Date()
      });
      await customer.save();
    } else {
      customer.lastContactedAt = new Date();
      await customer.save();
    }

    // Find or create conversation
    let conversation = await Conversation.findOne({
      customerPhone: phoneNumber,
      status: 'active'
    });

    if (!conversation) {
      conversation = new Conversation({
        customerPhone: phoneNumber
      });
    }

    // Add message
    await conversation.addMessage('customer', message, messageId);

    console.log('✅ Customer message stored in database');
  } catch (error) {
    console.error('❌ Error storing customer message:', error);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
  }
}

// Store agent message in database
async function storeAgentMessage(phoneNumber, message) {
  try {
    const conversation = await Conversation.findOne({
      customerPhone: phoneNumber,
      status: 'active'
    });

    if (conversation) {
      await conversation.addMessage('agent', message);
      console.log('✅ Agent message stored in database');
    }
  } catch (error) {
    console.error('❌ Error storing agent message:', error);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
  }
}

// Get conversation context for Claude
async function getConversationContext(phoneNumber) {
  try {
    // STRATEGY: Check in-memory FIRST (most recent, fastest)
    // Then fall back to MongoDB if in-memory is empty

    // Step 1: Check in-memory cache first (fastest and most up-to-date)
    if (conversationMemory.has(phoneNumber)) {
      const memoryMessages = conversationMemory.get(phoneNumber);
      if (memoryMessages.length > 0) {
        const recentMemory = memoryMessages.slice(-50); // Last 50 messages
        console.log(`💾 Retrieved ${recentMemory.length} messages from IN-MEMORY cache (most recent)`);
        return recentMemory.map(msg => ({
          role: msg.role,
          content: msg.content
        }));
      }
    }

    // Step 2: Try MongoDB (persistent storage)
    try {
      const conversation = await Conversation.findOne({
        customerPhone: phoneNumber,
        status: 'active'
      });

      if (conversation) {
        // Get last 50 messages for context (optimized for Groq upper tier 32k+ token limit)
        const recentMessages = conversation.getRecentMessages(50);

        if (recentMessages.length > 0) {
          // Format for Claude API
          const formattedMessages = recentMessages.map(msg => ({
            role: msg.role === 'customer' ? 'user' : 'assistant',
            content: msg.content
          }));

          console.log(`📚 Retrieved ${formattedMessages.length} messages from MongoDB`);

          // IMPORTANT: Also populate in-memory cache from MongoDB
          if (!conversationMemory.has(phoneNumber)) {
            conversationMemory.set(phoneNumber, recentMessages.map(msg => ({
              role: msg.role === 'customer' ? 'user' : 'assistant',
              content: msg.content,
              timestamp: msg.timestamp || new Date()
            })));
            console.log(`💾 Populated in-memory cache from MongoDB (${recentMessages.length} messages)`);
          }

          return formattedMessages;
        }
      }
    } catch (mongoError) {
      console.error('⚠️ MongoDB lookup failed:', mongoError.message);
      // Continue to fallback below
    }

    // Step 3: No history found anywhere
    console.log('📭 No conversation history found - starting fresh conversation');
    return [];

  } catch (error) {
    console.error('❌ Error in getConversationContext:', error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);

    // Ultimate fallback: check in-memory one more time
    if (conversationMemory.has(phoneNumber)) {
      const memoryMessages = conversationMemory.get(phoneNumber);
      const recentMemory = memoryMessages.slice(-50);
      console.log(`💾 EMERGENCY FALLBACK: Retrieved ${recentMemory.length} messages from in-memory cache`);
      return recentMemory.map(msg => ({
        role: msg.role,
        content: msg.content
      }));
    }

    console.log('⚠️ No conversation context available - returning empty array');
    return [];
  }
}

// Process message with Multi-Provider AI agent (Groq → Gemini → Rules)
async function processWithClaudeAgent(message, customerPhone, context = []) {
  try {
    console.log('🤖 Processing with Multi-Provider AI (Groq → Gemini → Rules)...');
    console.log(`📊 Context size: ${context.length} messages`);

    // CRITICAL: Add current message to context for AI processing
    // context already has history, we just need to add the new user message
    const fullContext = [...context, { role: 'user', content: message }];

    // ALSO store in conversationMemory for in-memory fallback (in case MongoDB fails)
    // RACE CONDITION FIX: Check existence before pushing
    if (!conversationMemory.has(customerPhone)) {
      conversationMemory.set(customerPhone, []);
    }
    conversationMemory.get(customerPhone).push({
      role: 'user',
      content: message,
      timestamp: new Date()
    });

    // Use multi-provider AI manager with automatic failover
    // Send last 50 messages for context (optimized for Groq upper tier 32k+ token limit)
    const result = await aiManager.getResponse(
      SYSTEM_PROMPT,
      fullContext.slice(-50), // Last 50 messages (including new message)
      message
    );

    console.log(`✅ Response from ${result.provider.toUpperCase()}: ${result.response.substring(0, 100)}...`);

    // Store AI response in in-memory cache
    conversationMemory.get(customerPhone).push({
      role: 'assistant',
      content: result.response,
      timestamp: new Date()
    });

    // Limit in-memory cache to last 20 messages per customer
    const customerMemory = conversationMemory.get(customerPhone);
    if (customerMemory.length > 20) {
      conversationMemory.set(customerPhone, customerMemory.slice(-20));
    }

    return result.response;

  } catch (error) {
    console.error('❌ Error in AI processing:', error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);

    // Ultimate fallback (should rarely happen since aiManager has its own fallbacks)
    return "Thank you for your message! We're experiencing technical difficulties. Please share your email and I'll send you our catalog and product details right away. 🌿";
  }
}


// Send WhatsApp message
async function sendWhatsAppMessage(to, text) {
  try {
    // Clean token - remove ALL whitespace and control characters
    const cleanToken = CONFIG.WHATSAPP_TOKEN.replace(/[\r\n\t\s]/g, '');

    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${cleanToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Message sent successfully');
    return response.data;
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
    throw error;
  }
}

// Send WhatsApp image
async function sendWhatsAppImage(to, imageUrl, caption = '') {
  try {
    const cleanToken = CONFIG.WHATSAPP_TOKEN.replace(/[\r\n\t\s]/g, '');
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: { link: imageUrl, caption: caption }
      },
      { headers: { 'Authorization': `Bearer ${cleanToken}`, 'Content-Type': 'application/json' } }
    );
    console.log('📸 Image sent successfully');
    return response.data;
  } catch (error) {
    console.error('❌ Error sending image:', error.response?.data || error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
    throw error;
  }
}

// Send WhatsApp document (PDF, DOC, etc.)
async function sendWhatsAppDocument(to, documentUrl, filename, caption = '') {
  try {
    const cleanToken = CONFIG.WHATSAPP_TOKEN.replace(/[\r\n\t\s]/g, '');
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'document',
        document: {
          link: documentUrl,
          filename: filename,
          caption: caption
        }
      },
      { headers: { 'Authorization': `Bearer ${cleanToken}`, 'Content-Type': 'application/json' } }
    );
    console.log('📄 Document sent successfully:', filename);
    return response.data;
  } catch (error) {
    console.error('❌ Error sending document:', error.response?.data || error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
    throw error;
  }
}

// Send typing indicator
async function sendTypingIndicator(to) {
  try {
    // Clean token - remove ALL whitespace and control characters
    const cleanToken = CONFIG.WHATSAPP_TOKEN.replace(/[\r\n\t\s]/g, '');

    await axios.post(
      `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: '...' }
      },
      {
        headers: {
          'Authorization': `Bearer ${cleanToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('⚠️ Error sending typing indicator:', error.message);
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: 'ROBUST-v14-MULTI-PDF',
    groqKeys: aiManager.groqClients ? aiManager.groqClients.length : 0,
    services: {
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      queue: messageQueue ? 'active' : 'inactive'
    }
  };

  res.json(health);
});

// Stats endpoint
app.get('/stats', async (req, res) => {
  try {
    const totalCustomers = await Customer.countDocuments();
    const activeConversations = await Conversation.countDocuments({ status: 'active' });
    const queueStats = await messageQueue.getJobCounts();

    res.json({
      customers: totalCustomers,
      activeConversations,
      queue: queueStats
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Error retrieving stats' });
  }
});

// Sentry error handler (must be after all routes)
if (CONFIG.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');

  // Fix null reference crash - only close queue if it exists
  if (messageQueue) {
    await messageQueue.close();
  }
  await mongoose.connection.close();

  process.exit(0);
});

// Start server FIRST (so Render sees it's alive immediately)
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 WhatsApp-Claude Production Server`);
  console.log(`📡 Server running on port ${CONFIG.PORT}`);
  console.log(`🔗 Webhook URL: https://your-domain.com/webhook`);
  console.log(`🏥 Health check: http://localhost:${CONFIG.PORT}/health`);
  console.log(`📊 Stats: http://localhost:${CONFIG.PORT}/stats\n`);

  // Connect to services in the background (non-blocking)
  console.log('🔄 Connecting to databases...');
  connectDatabase().catch(err => console.error('Database connection failed:', err));
  connectQueue().catch(err => console.error('Queue connection failed:', err));
});
