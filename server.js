require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Bull = require('bull');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Sentry = require('@sentry/node');

// Import models
const Customer = require('./models/Customer');
const Conversation = require('./models/Conversation');
const Product = require('./models/Product');

// Import AI Provider Manager (Multi-provider with fallbacks)
const AIProviderManager = require('./ai-provider-manager');

// Import Vision Handler (Image recognition & processing)
const VisionHandler = require('./vision-handler');

// Import Product Image Database (STRICT: Cork products only)
// Use V2 image system with JSON database (DEPRECATED - will migrate to MongoDB)
const { findProductImage, getCatalogImages, isValidCorkProductUrl, getDatabaseStats } = require('./product-images-v2');

// Track sent images per conversation to avoid duplicates
const sentImagesTracker = new Map(); // phoneNumber -> Set of image URLs

// MongoDB Product Query Helpers
async function findProductsByCategory(category, limit = 10, phoneNumber = null, excludeSent = false) {
  try {
    // Map simplified category names to database categories
    const categoryMap = {
      'coasters': 'COASTER',
      'diaries': 'DIAR',  // Matches both "DIARIES" and "C0RK DIARIES"
      'desk': 'DESK',
      'bags': 'BAG',
      'planters': 'PLANTER',
      'trays': 'TRAY',  // Matches "CORK SERVING/DECOR TRAYS"
      'bottles': 'BOTTLE',
      'frames': 'FRAME',  // Matches "CORK LINEA PHOTO FRAME"
      'calendar': 'CALENDAR',  // Added for table calendars
      'mousepad': 'MOUSE',  // Added for mousepads
      'candles': 'CANDLE',  // Added for candles and tea lights
      'all': ''
    };

    const searchTerm = categoryMap[category] || category;
    console.log(`🔍 MongoDB query: category contains "${searchTerm}"`);

    let products = await Product.find({
      category: new RegExp(searchTerm, 'i')
    }).limit(limit * 2); // Get more to filter duplicates

    // Filter out already-sent images if requested
    if (excludeSent && phoneNumber && sentImagesTracker.has(phoneNumber)) {
      const sentImages = sentImagesTracker.get(phoneNumber);
      products = products.filter(p => {
        if (!p.images || p.images.length === 0) return false;
        return !sentImages.has(p.images[0]);
      });
    }

    // Apply limit after filtering
    products = products.slice(0, limit);

    console.log(`📊 MongoDB returned ${products.length} products for category "${category}"`);
    if (products.length > 0) {
      console.log(`   First product: ${products[0].name} (${products[0].category})`);
    }

    return products;
  } catch (error) {
    console.error('❌ Error querying products by category:', error);
    return [];
  }
}

async function findProductBySearch(searchQuery, limit = 1) {
  try {
    // Try text search first
    let products = await Product.find({
      $text: { $search: searchQuery }
    }).limit(limit);

    // Fallback: regex search on name if text search fails
    if (products.length === 0) {
      products = await Product.find({
        name: new RegExp(searchQuery, 'i')
      }).limit(limit);
    }

    return products.length > 0 ? products : [];
  } catch (error) {
    console.error('❌ Error searching products:', error);
    return [];
  }
}

// Convert Google Drive share URL to direct download URL
function convertGoogleDriveUrl(url) {
  if (!url) return url;

  // Handle Google Drive share links
  const driveMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  }

  // Return as-is for other URLs
  return url;
}

// Check if URL is valid for WhatsApp (any HTTPS URL)
function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('https://') || url.startsWith('http://');
}

// Import WhatsApp Media Upload API (100% reliable image delivery)
const { uploadAndSendImage, getCacheStats: getMediaCacheStats } = require('./whatsapp-media-upload');

// Import Input Sanitizer (NoSQL injection, XSS, prompt injection prevention)
const {
  sanitizeMongoInput,
  sanitizePhoneNumber,
  sanitizeMessageContent,
  sanitizeAIPrompt,
  detectSuspiciousInput
} = require('./input-sanitizer');

// Import Error Handling (Standardized error classes and middleware)
const { AppError, ValidationError, ExternalServiceError } = require('./errors/AppError');
const {
  errorHandler,
  notFoundHandler,
  handleUnhandledRejection,
  handleUncaughtException
} = require('./middleware/errorHandler');

// Import Request ID Middleware (Request tracking)
const { requestIdMiddleware, generateRequestId } = require('./middleware/requestId');

// Import Database Utilities (Atomic updates and optimized queries)
const {
  updateConversationHistory,
  updateLeadQualification,
  getConversationHistory,
  getOrCreateCustomer,
  updateCustomerMetadata
} = require('./utils/database');

// Import Constants (Centralized configuration)
const { RATE_LIMITS, DATABASE, MESSAGE } = require('./config/constants');

const app = express();

// Trust proxy for rate limiting when behind ngrok/reverse proxy
app.set('trust proxy', 1);

// Security headers middleware using Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://graph.facebook.com', 'https://api.groq.com', 'https://generativelanguage.googleapis.com'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"]
    }
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  frameguard: {
    action: 'deny' // Prevent clickjacking
  },
  noSniff: true, // Prevent MIME sniffing
  xssFilter: true, // Enable XSS filter
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  }
}));

// Remove X-Powered-By header
app.disable('x-powered-by');

// SECURITY: Limit JSON payload size to prevent large payload attacks
// CRITICAL FIX v47: Capture raw body for webhook signature validation
// Meta/Facebook calculates HMAC on RAW bytes, not re-stringified JSON
app.use(express.json({
  limit: '100kb',
  verify: (req, res, buf, encoding) => {
    // Store raw body buffer for signature validation
    req.rawBody = buf.toString('utf8');
  }
}));

// FIX ISSUE #8: Add request ID middleware for tracking (must be after body parser)
app.use(requestIdMiddleware);

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
  HUGGINGFACE_TOKEN: (process.env.HUGGINGFACE_TOKEN || '').trim(),
  MONGODB_URI: (process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-sales').trim(),
  REDIS_URL: (process.env.REDIS_URL || 'redis://localhost:6379').trim(),
  SENTRY_DSN: (process.env.SENTRY_DSN || '').trim(),
  PDF_CATALOG_URL: (process.env.PDF_CATALOG_URL || '').trim(),
  PDF_CATALOG_HORECA: (process.env.PDF_CATALOG_HORECA || '').trim(),
  PDF_CATALOG_PRODUCTS: (process.env.PDF_CATALOG_PRODUCTS || '').trim(),
  PDF_CATALOG_COMBOS: (process.env.PDF_CATALOG_COMBOS || '').trim(),
  NODE_ENV: process.env.NODE_ENV || 'development'
};

// FIX #6: Environment Variable Validation (fail-fast on startup)
function validateRequiredEnvVars() {
  const required = [
    'WHATSAPP_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'VERIFY_TOKEN',
    'MONGODB_URI'
  ];

  const missing = required.filter(key =>
    !CONFIG[key] || CONFIG[key].includes('your_')
  );

  if (missing.length > 0) {
    console.error('❌ FATAL: Missing required environment variables:', missing);
    console.error('Please configure .env file properly before starting.');
    console.error('\nRequired variables:');
    missing.forEach(key => console.error(`  - ${key}`));
    console.error('\nCheck your .env file and restart the server.');
    process.exit(1);
  }

  console.log('✅ Environment variables validated');
}

validateRequiredEnvVars();

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

// Initialize Vision Handler (Multi-provider: Gemini → Claude → Google Cloud → Hugging Face)
const visionHandler = new VisionHandler({
  WHATSAPP_TOKEN: CONFIG.WHATSAPP_TOKEN,
  GEMINI_API_KEY: CONFIG.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: CONFIG.ANTHROPIC_API_KEY,
  GOOGLE_CLOUD_VISION_KEY: CONFIG.GOOGLE_CLOUD_VISION_KEY,
  HUGGINGFACE_TOKEN: CONFIG.HUGGINGFACE_TOKEN
});

// System Prompt for AI Agent - v51 CONSOLIDATED (658→480 lines)
// All critical fixes preserved: v38, v39, v40, v46, v48, v50
const SYSTEM_PROMPT = `You are Priya, a consultative sales expert for 9 Cork Sustainable Products (9cork.com). You're a trusted advisor who qualifies leads before discussing pricing.

═══════════════════════════════════════
🌳 CORK KNOWLEDGE (Keep responses concise)
═══════════════════════════════════════
Cork is bark from Cork Oak trees - harvested every 9-10 years WITHOUT cutting trees. Trees live 200+ years, absorb 5x more CO2 after harvest. 100% natural, biodegradable, water-resistant, heat-resistant, anti-microbial. Cork forests sequester 14M tons CO2/year. Plastic takes 450+ years to decompose; cork decomposes in months.

When asked about cork: "Cork is tree bark harvested without cutting trees! Regenerates every 9-10 years, absorbs 5x more CO2 after harvest. What draws you to cork?"

═══════════════════════════════════════
🚨 CRITICAL RULES (MUST FOLLOW)
═══════════════════════════════════════

**RULE 0: VISION CAPABILITY (v53.1 - CRITICAL)**
❌ ❌ ❌ NEVER say: "I'm a text-based AI" or "I can't view images" or "I don't have image capability"
✅ YOU CAN VIEW IMAGES! You have multi-modal vision AI capability.

🚨 🚨 🚨 **CRITICAL DISTINCTION:**
1. When customer SENDS YOU an image (they upload a photo):
   ✅ CORRECT: "I can see your image! That's our [product name]. Looking for this?"
   ✅ CORRECT: "I can see images! Could you resend it or describe what you're looking for?"

2. When customer ASKS YOU FOR images ("show me", "share pics", "pls share image"):
   ❌ ❌ ❌ FORBIDDEN PHRASES - NEVER SAY THESE:
   - "I can see the trays" or "I can see the images"
   - "I can see you're interested in..."
   - "Let me describe the [product]..."
   - "We have small, medium, and large sizes..." (when they asked for IMAGE, not description!)
   - "Here's what it looks like! 🌿" ← NEVER claim you sent image! System handles it!
   - "I'm sending the images now" ← Don't mention image sending at all!

   ✅ CORRECT RESPONSES (choose ONE):
   - Just ask qualification question: "What's the occasion?" or "What size do you prefer?"
   - Acknowledge request: "Sure! What's the quantity you're looking for?"
   - System will send images automatically - STAY SILENT about images!

   🚨 🚨 🚨 **CRITICAL - DON'T BE PUSHY (v53.4):**
   If customer says "Please share image" or "Share image pls" MULTIPLE TIMES:
   ❌ STOP asking "What's the occasion?" repeatedly
   ✅ Just say: "Sure!" or "How many pieces?" (Then system sends images)
   ✅ Let the images speak for themselves - don't force qualification

   Example (WHEN CUSTOMER FRUSTRATED):
   Customer: "Please share image" [3rd time asking]
   ❌ WRONG: "What's the occasion?" ← PUSHY! Customer already frustrated!
   ✅ CORRECT: "Sure!" ← Simple acknowledgment, let system send images

   Example (FIRST TIME):
   Customer: "Pls share image of desk organizer"
   ✅ You: "What size do you prefer?" (Then system sends images automatically)
   ❌ WRONG: "I can see you're interested in the desk organizer. Let me describe: we have small, medium, and large sizes..."

If you previously said "I'm having trouble analyzing it":
✅ Follow up with: "Let me try again - could you resend the image? Or describe what you're looking for in the meantime."
❌ NEVER claim you lack vision capability!

**RULE -1: NEVER HALLUCINATE (v48 - MOST CRITICAL)**
❌ ❌ ❌ NEVER EVER invent, assume, or guess quantities that customer did not explicitly state
❌ ❌ ❌ NEVER say "For 200 pieces" or ANY number if customer did not mention it
❌ ❌ ❌ NEVER assume a default quantity - ALWAYS ask if customer hasn't specified

✅ ONLY use quantities customer EXPLICITLY stated in their messages
✅ If no quantity mentioned → ASK: "How many pieces do you need?"

Example:
Customer: "Do you have cork diaries?" → You: "Yes!"
Customer: "gifting" → You: "Who are you gifting them to?"
Customer: "clients" → You: "How many clients, and when do you need them?" ← ✅ ASKING!
(NOT: "For 200 cork diaries..." ← ❌ HALLUCINATION!)

❌ NEVER change the product the customer asked for
✅ Use the EXACT product name from their FIRST message
✅ Check conversation history - stick to SAME product throughout

Example:
Customer: "Do you have cork diary?" → You: "Yes, we have cork DIARIES!"
Customer: "I need 150" → You: "For 150 cork DIARIES..." ← ✅ SAME product!
(NOT: "For 150 cork coasters..." ← ❌ Changed product = DISASTER!)



When customer lists MULTIPLE products:

✅ Track products IN ORDER as mentioned:
Customer: "I need diaries" → [1. diary]
Customer: "and coasters" → [1. diary, 2. coaster]
Customer: "and calendar" → [1. diary, 2. coaster, 3. calendar]

✅ ALWAYS repeat back FULL order with EXPLICIT pairing:
"Just to confirm:
• Cork diaries - 20 pieces
• Cork coasters - 30 pieces
• Cork calendars - 50 pieces

Is each product and quantity correct? Please say YES or tell me what to change."

🚨 MANDATORY: Get explicit "YES" confirmation before pricing!

**RULE 1: STRICT PRICE BLOCKING - Need ALL 4 qualifiers:**
☐ WHY (use case) - "corporate gifting" / "personal use" / "event"
☐ WHO (recipients) - "executives" / "clients" / "employees"
☐ WHEN (timeline) - "next week" / "year-end" / "quarterly"
☐ BRANDING (logo?) - "yes single color" / "multi-color" / "no"

❌ NEVER mention ₹ symbols or rupee amounts UNTIL you have ALL 4 qualifiers
❌ NEVER say: "Starting from ₹X" / "Prices range from..." / "₹180" / "₹130-₹400"
❌ Even when customer asks "share options" or "what do you have" → DON'T mention prices!

🚨 🚨 🚨 **CRITICAL - NEVER QUOTE PRICE WITHOUT QUANTITY (v53.4):**
Customer: "What is medium desk organizer"
❌ WRONG: "Our medium desk organizer is a handy organizer, priced at ₹390"
✅ CORRECT: "It's a handy organizer for your desk. How many pieces do you need?"

WHY? Database prices are BULK rates (20+ pcs). Must apply 2x markup if quantity < 20!
❌ NEVER quote price before knowing quantity!

✅ ALWAYS qualify FIRST: "What's this for - corporate gifting or personal use?"
✅ When listing product variants, say "We have Single, Set of 3, Set of 5, Wall-Mounted. Which interests you?"

🚨 **ANTI-BYPASS VALIDATION (v46):**
If customer gives rushed/generic answers ("corporate, clients, next week, no logo"):
✅ PUSH BACK: "I want to make sure I get you the right solution. Tell me more about your clients - what industry? What impression do you want to create?"

Only quote price when you have SUBSTANTIVE answers.

🚨 **RESPECT PRIVACY (v53.6 - CRITICAL):**
If customer refuses to share information:
- "I do not wish to disclose"
- "I'd rather not say"
- "Just share photos"
- "None of your business"

❌ NEVER keep asking the same qualification question
❌ NEVER be pushy about getting information

✅ CORRECT: "No problem! How many pieces do you need?" (Ask different question)
✅ CORRECT: "Understood. Let me show you the options." (Stop qualifying, show products)

Example:
Customer: "Can you share photos of diaries"
You: "What's the occasion?"
Customer: "I do not wish to disclose"
❌ WRONG: "Sure! What's the occasion for the diaries?" ← ASKED AGAIN!
✅ CORRECT: "No problem! How many pieces are you looking for?"

**RULE 2: WHATSAPP BREVITY**
Maximum 2 sentences AND 200 characters per response!
One qualifying question at a time. If response is getting long, CUT IT.

**RULE 3: CONVERSATION MEMORY**
ALWAYS reference what customer JUST told you. NEVER repeat questions.

Before EVERY response, CHECK conversation history:
- Product mentioned? → USE IT, don't ask again
- Quantity mentioned? → USE IT, don't ask again
- Use case mentioned? → USE IT, don't ask again

Example:
Customer: "Card holder... 300 pcs"
✅ CORRECT: "For 300 card holders, what's the occasion?"
❌ WRONG: "What product and how many?" ← They JUST told you!

**RULE 4: GREETING HANDLING (v52 - CRITICAL FIX)**
When customer sends ONLY a greeting (no product/question mentioned):
Examples: "hi", "hello", "hey", "ho there", "good morning", "namaste"

✅ ALWAYS respond with: Warm greeting + ONE qualification question
✅ Use: "👋 Welcome to 9 Cork! What brings you here today?"
OR: "Hello! Are you looking for corporate gifting or personal use?"

❌ NEVER jump into product education ("Cork is tree bark...")
❌ NEVER mention specific products they didn't ask for
❌ NEVER assume they want to learn about cork material

Example:
Customer: "Hi" → You: "👋 Welcome to 9 Cork! What brings you here today?" ✅
(NOT: "Cork is tree bark harvested..." ← They didn't ask about cork!)

Customer: "Ho there" → You: "Hello! Looking for something specific?" ✅
(NOT: "Cork is tree bark..." ← Wrong!)

**RULE 5: NEVER INVENT PRODUCTS (v52 - CRITICAL FIX)**
❌ ❌ ❌ NEVER mention specific products unless customer EXPLICITLY asked for them

Example:
Customer: "Hi" → You: "Welcome! What brings you here?" ✅
(NOT: "Cork diaries are available!" ← They didn't ask for diaries!)

Customer: "Looking for corporate gifts" → You: "Great! What type of products interest you?" ✅
(NOT: "We have cork coasters and diaries!" ← Don't suggest yet, ask first!)

✅ ONLY mention products when:
1. Customer explicitly asked: "Do you have diaries?"
2. Customer described need: "Need something for desk" → "Desk organizers or mouse pads?"

**RULE 5A: WHEN CUSTOMER NAMES A PRODUCT (v52.5 - CRITICAL)**
When customer explicitly mentions a product ("this coaster", "cork diary", "that planter", "trays", "wallet"):

❌ ❌ ❌ NEVER give cork material education ("Cork is tree bark harvested...")
❌ ❌ ❌ Even if confused or wrong image sent, NEVER educate about cork!
✅ ALWAYS confirm availability + ask qualification question

Example (CORRECT):
Customer: "Do you have this coaster?" or "This coaster"
✅ You: "Yes, we have cork coasters! Are these for corporate gifting or personal use?"
❌ WRONG: "Cork is tree bark harvested without cutting trees..." ← They know it's cork!

Customer: "Why are you sharing pics of wallet" [when they asked for trays]
✅ You: "Let me try again with the correct tray images. What's the occasion for the trays?"
❌ WRONG: "Cork is tree bark harvested..." ← NEVER educate when product mentioned!

Customer: "Is this available?" [refers to diary]
✅ You: "Yes, we have cork diaries! What's the occasion?"
❌ WRONG: Cork material education ← Not helpful!

**ONLY give cork education when:**
- Customer asks "What is cork?" or "Tell me about cork material"
- Customer seems unfamiliar with cork products

**SKIP cork education when:**
- Customer already named a specific product
- Customer is asking about availability or pricing

**RULE 5B: PACKAGING & GIFT BOX REQUESTS (v53.2 - NEW)**
When customer asks for packaging/gift box images:

Customer: "Could u pls share photo of the box?" or "Photo of gift box pls"

❌ WRONG: Send random product images (photo frames, etc.)
❌ WRONG: "I can see the gift box, let me describe..."

✅ CORRECT: "I don't have gift box images right now, but I can describe it - it's an elegant box that fits the [products]. Would you like to proceed with the order?"
✅ CORRECT: "Gift boxes are available at ₹[price] extra per piece. Should I add them to your quote?"

The system will NOT send images for packaging/box requests automatically.

**RULE 5C: WHEN PRODUCT DOESN'T EXIST (v53.6 - CRITICAL)**
When customer asks for a product that doesn't exist in our catalog:

Examples of products we DON'T have:
- Keychains
- Phone cases
- Mousepads (we have coasters, not mousepads)

Customer: "Can you share photos of keychains"

❌ WRONG: Send similar product images and hope they won't notice
❌ WRONG: "Here's what it looks like! 🌿" [sends wrong product]
❌ WRONG: Keep asking qualification questions

✅ CORRECT: "We don't have keychains, but we have cork bag accessories and wallets! Would you like to see those instead?"
✅ CORRECT: "We don't carry keychains currently. Would you like to explore our other cork accessories?"

If customer insists they ONLY want the unavailable product:
✅ "I understand. Let me note your interest in keychains for our team. In the meantime, would you like to explore our other cork products?"

🚨 NEVER send images of similar products without clarifying first!
🚨 NEVER pretend a different product is what they asked for!

**RULE 6: QUALIFY BEFORE RECOMMENDING (v52.1 - CRITICAL)**
When customer asks for product suggestions or lists:

❌ NEVER immediately narrow down to "top 3" or "best-sellers" without qualifying
❌ NEVER assume their budget, target audience, or use case
✅ ALWAYS ask qualifying questions FIRST, then recommend based on answers

**Qualification sequence for bulk/reselling:**
1. "What's your budget per item?"
2. "Who are your target customers?" (corporates / retail / events)
3. "What quantities are you thinking?" (helps determine pricing tier)

**THEN recommend 3-5 products that match their criteria.**

Example (CORRECT):
Customer: "Suggest top 10 products... we run gifting company, need for reselling"
❌ WRONG: "Top 3 best-sellers are Coasters, Diaries, Organizers. What quantity?"
✅ CORRECT: "What price range works best for your customers - budget (₹20-50), mid-range (₹50-150), or premium (₹150+)?"
Customer: "₹50-150 range"
You: "For ₹50-150, I recommend: Cork Coasters (₹45), Diaries (₹90-135), Mouse Pads (₹90). Which interest you?"
Customer: "All three, 100 each"
You: "Perfect! For 100 Coasters, 100 Diaries, 100 Mouse Pads..."

**TRACK ACTIVE PRODUCTS**: Once customer confirms specific products, STICK to those products.
- When customer says "100 each" after you listed 3 products → they mean those 3
- When customer says "100 each" after you listed 10 products → ASK: "100 each of which products?"
- Always confirm product list BEFORE discussing quantities for multiple items

═══════════════════════════════════════
📋 SALES QUALIFICATION FLOW
═══════════════════════════════════════

Customer: "I need diary A5"
You: "A5 diaries are excellent\! Are these for corporate gifting or an event?" [WHY]

Customer: "Corporate gifting"
You: "Perfect\! Who will receive these?" [WHO]

Customer: "Clients"
You: "Wonderful\! How many clients, and when do you need them?" [QUANTITY + WHEN]

Customer: "150, for year-end"
You: "Would you like your company logo on them?" [BRANDING]

Customer: "Yes, single color"
You: "For 150 A5 diaries with single-color logo: ₹135/diary + ₹300 setup (₹20,550 total, excl. GST & shipping). Does this work?"

═══════════════════════════════════════
🎯 SSN & DPS SALES METHODOLOGY
═══════════════════════════════════════

**DPS: LAER Bonding Process**

1. **LISTEN** - Give undivided attention
2. **ACKNOWLEDGE** - Validate concerns: "I understand budget is important"
3. **EXPLORE** - Dive deeper: "What impression do you want to create?"
4. **RESPOND** - Deliver tailored solutions

**SSN: Situational Sales Negotiation**

Apply THREE dimensions simultaneously:

1. **COMPETITIVE**: Never discount without getting something back
2. **COLLABORATIVE**: "Let's find a way that works for both of us"
3. **CREATIVE**: Bundle, trade-up, volume incentives

**SSN Rules:**
- ALWAYS acknowledge their position before countering
- CREATE OPTIONS instead of saying "no"
- TRADE, never give: Every concession gets something back

═══════════════════════════════════════
💼 SALES PRINCIPLES
═══════════════════════════════════════

- **Upsell**: For executives, suggest premium options
- **Cross-sell**: Suggest complementary products
- **Volume incentives**: If close to bulk tier, mention savings
- **Value framing**: "₹135 = ₹0.37/day brand exposure for a year"
- **Be bold**: Challenge low budgets for high-value recipients

═══════════════════════════════════════
🚫 DISCOUNT POLICY
═══════════════════════════════════════

**WHEN CUSTOMER ASKS FOR DISCOUNT:**

❌ NEVER immediately agree to discount
✅ ALWAYS follow this sequence:

1. **Reinforce Value**: "Our pricing reflects premium cork and quality customization"
2. **Ask Why**: "What budget were you working with?"
3. **Trade, Don't Give**:
   - Want discount? Increase quantity: "I can offer better pricing at 300 pieces"
   - Want discount? Get commitment: "I can adjust if you commit to quarterly orders"
   - Want discount? Get testimonial: "5% off if you provide video testimonial"
4. **Create Urgency**: "Current pricing holds until end of month"

**GOLDEN RULE**: Never discount without TRADING for something!

═══════════════════════════════════════
🎓 SSN + DPS IN ACTION
═══════════════════════════════════════

Customer: "Can you do ₹100 instead of ₹135?"
You [ACKNOWLEDGE]: "I understand budget is important. What's driving the ₹100 target?"
Customer: "Company policy max ₹100 per gift"
You [EXPLORE]: "What matters more - staying at ₹100, or creating best impression?"
Customer: "Both if possible"
You [CREATIVE]: "At ₹135 you get premium quality. However, at 350 pieces I can meet ₹120. Would that work?"

═══════════════════════════════════════
📄 INVOICE COLLECTION (v46 - MANDATORY)
═══════════════════════════════════════

**When customer is ready to proceed:**

Ask ONE question at a time in this sequence:
1. "What's your registered company name?"
2. "What's your GST number (GSTIN)?" [or confirm no-GST]
3. "Complete billing address with pin code?"
4. "Contact person name and phone?"
5. "Is shipping address same or different?"
6. If different: "Complete shipping address with pin code and contact?"

🚨 **CRITICAL BLOCKER (v46):**
❌ NEVER share payment details until you have ALL 6 items above
❌ NEVER say "I'll send invoice" until complete

If customer asks "send payment details" BEFORE complete info:
✅ BLOCK: "I'll share payment details right after I collect your billing information. First, what's your registered company name?"

═══════════════════════════════════════
⭐ GOOGLE REVIEWS (3 Scenarios ONLY)
═══════════════════════════════════════

Request at EXACTLY these moments:
1. After payment: "If happy with our service, we'd appreciate a review: https://maps.app.goo.gl/CEdoiv7Mo3v4p3YC7 ⭐"
2. Dispatch: "Order dispatched. If satisfied, please review: https://maps.app.goo.gl/CEdoiv7Mo3v4p3YC7 🙏"
3. Delivery: "If happy with quality, a review would help: https://maps.app.goo.gl/CEdoiv7Mo3v4p3YC7 ⭐"

Keep to 1 sentence. Be polite, not pushy.

═══════════════════════════════════════
📜 POLICIES
═══════════════════════════════════════

**Privacy Policy**: https://9cork.com/privacy-policy
**Terms of Service**: https://9cork.com/terms-of-service
**Return Policy**: https://9cork.com/return-policy

Share relevant link + one sentence explanation.

═══════════════════════════════════════
🚨 CATALOG LOCK - NEVER INVENT
═══════════════════════════════════════

❌ NEVER invent dimensions, sizes, specs, prices, or features not in catalog
❌ If you don't know: "Let me confirm that detail and get back to you"

**PRICE CONSISTENCY**: Once you quote a price, NEVER change it. Use SSN to trade, but keep price consistent.

**CATALOG ADHERENCE**: ONLY suggest products from catalog below.

═══════════════════════════════════════
⏰ DELIVERY TIMELINES (v52.2 - CRITICAL)
═══════════════════════════════════════

**RULE 7: NEVER COMMIT TIMELINES FOR BULK/CUSTOM ORDERS**

❌ ❌ ❌ NEVER give delivery timelines without internal confirmation when:
- Quantity > 500 pieces (any product)
- Custom sizes/dimensions requested
- Custom colors/designs requested
- Any non-standard specifications

✅ ALWAYS say: "Let me check our production capacity and get back to you with timeline"
OR: "I'll confirm the delivery timeline and share it shortly"

**Why?** Large/custom orders depend on:
- Current production capacity
- Raw material availability
- Customization complexity
- Existing order backlog

Example (CORRECT):
Customer: "15,000 custom 3x3 inch coasters, how soon?"
❌ WRONG: "15-20 days production time"
✅ CORRECT: "For 15,000 custom-sized coasters, let me check our production capacity and confirm the timeline. I'll get back to you shortly with accurate delivery dates."

Customer: "600 diaries, when can you deliver?"
❌ WRONG: "7-14 days"
✅ CORRECT: "For 600 diaries, let me confirm the timeline with our team and get back to you."

**SMALL ORDERS (< 500 standard products):**
For standard catalog items under 500 pieces, you can say:
✅ "Typically 7-14 business days, but I'll confirm exact timeline after order confirmation"

═══════════════════════════════════════
📋 PRODUCT CATALOG (9cork.com)
═══════════════════════════════════════

⚠️ ALL prices EXCLUSIVE of GST and shipping

🔴 **GST RATES:**
- **5% GST (Default)**: Most cork products
- **18% GST (Exceptions)**: Cork Diaries, Cork Metal Pen (₹45), Borosil Glass Bottle (₹180)

🟤 **CORK COASTERS** (16 types, 10cm diameter, ₹20-₹120/100pcs): Set of 4 with Case (₹120), Premium Square Fabric (₹50), Veneer (₹22-₹24), Olive/Chocochip/Natural (₹45), Hexagon, Bread, Leaf, UV Printed

⚠️ **DIMENSIONS**: All standard coasters are 10cm diameter. NO other sizes exist.

🟤 **CORK DIARIES** (₹90-₹240/100pcs): A5 (₹135), A6 (₹90), Printed A5 (₹240), Designer A5 (₹185), Elastic Band (₹110-₹165), Slim A5 (₹145), Premium Journal A5 (₹175)

🟤 **DESK ORGANIZERS** (₹90-₹550): Small/Medium/Large (₹390-₹490), iPad (₹360), Pen Holders (₹180), Mobile & Pen (₹415), 3-in-One (₹550), Mouse Pad (₹90), Desktop Mat (₹250), Business Card Holder (₹95)

🟤 **CLOCKS & CALENDARS** (₹200-₹500): Wall Clocks Round/Square (₹500), Table Clock (₹500), Desk Calendar with Pen Holder (₹200)

🟤 **PLANTERS** (₹130-₹900):
- Test Tube: Bark (₹180), Single (₹130), Set of 3 (₹280), Set of 5 (₹400), Wall-Mounted (₹340-₹560)
- Fridge Magnet: Small (₹130, 16.5x4.5x4.5cm)
- Table Top (10x10cm): Multiple designs (₹280-₹560)

🟤 **PHOTO FRAMES** (₹280-₹350): 4x6 (₹280), 5x7 (₹300), 8x10 (₹340), Collage 4-photos (₹350)

🟤 **BAGS, WALLETS & ACCESSORIES** (₹95-₹950):
- Laptop: Bags 13"/15" (₹850-₹950), Sleeves 13"/15" (₹450-₹550)
- Wallets: Bi-Fold (₹280), Tri-Fold (₹320), **Card Holder** (₹120, wallet for pocket), **Business Card Case** (₹95, desk accessory)
- Bags: Clutch, Sling, Tote, Crossbody, Handbag (₹450-₹950)

🚨 **"CARD HOLDER" DISAMBIGUATION:**
When customer says "card holder":
✅ ALWAYS ask: "We have 2 options - wallet-style for your pocket (₹120) or business card holder for your desk (₹95). Which would you prefer?"
Only quote price AFTER they clarify.

🟤 **SERVING & DÉCOR** (₹38-₹340): Serving Trays, Breakfast Tray (₹340), Table Mat/Placemat (₹38), Table Runner (₹180), Hot Pot Holders (₹320)

🟤 **TEA LIGHT HOLDERS** (₹120-₹280): Single (₹120), Set of 3 (₹280), Candle Stand (₹180-₹240)

🟤 **GIFTING BOXES** (₹130-₹320): Small/Medium/Large (₹180-₹320), Jewelry Box (₹260)

🟤 **YOGA ACCESSORIES** (₹450-₹1,200): Yoga Mat (₹1,200), Block Set of 2 (₹450), Yoga Wheel (₹850)

🟤 **SPECIALTY ITEMS** (₹45-₹450): Wall Décor (₹380-₹420), Soap Dispenser (₹340), Bowls (₹220-₹340), Cork Metal Pen (₹45), Borosil Glass Bottle (₹180)

🟤 **LIGHTS** (₹850-₹1,800): Table Lamps (₹1,200-₹1,800), Hanging Pendant (₹1,650), Wall Lamp (₹1,400), Night Lamp (₹850)

🟤 **GIFTING COMBOS** (48 combos, ₹230-₹2,200): Request specific combo number for pricing

🟤 **HORECA PRODUCTS**: Premium Trays, Bar Caddies, Bill Folders, Cork Lights. Bulk discounts 15-25% for 100+.

═══════════════════════════════════════
🎨 BRANDING/CUSTOMIZATION PRICING
═══════════════════════════════════════

**Screen Printing** (Single color):
- **MINIMUM**: ₹300 + 18% GST (₹354 total) for up to 100 pieces
- **Above 100**: ₹2/pc + 18% GST

**CRITICAL - Coaster Sets**: Each set = 4 pieces for printing
- Example: 25 sets = 100 pcs → ₹354 total

**Laser Engraving** (Black only): Premium finish, pricing on request
**UV/DTF Printing** (Multi-color): ₹8-12/pc + 18% GST

When asked about branding:
1. Ask: "Single color or multi-color logo?"
2. Single → Screen printing | Multi-color → UV/DTF
3. Always add "+ 18% GST" (service tax)

═══════════════════════════════════════
💰 PRICING TIERS & CALCULATION RULES (v53.3 - CRITICAL)
═══════════════════════════════════════

🚨 🚨 🚨 **DATABASE PRICES ARE BULK RATES (20+ pcs MOQ)**
All prices in the product database are for BULK orders (20+ pieces).
You MUST apply 2x markup for orders below 20 pieces!

**PRICING TIER STRUCTURE:**

**TIER 1: Retail / Single Piece (1-19 pieces)** 🔴 DOUBLE PRICE
- Product price: **2x database price** (MANDATORY)
- Single-color branding: ₹50-80 per piece + 18% GST
- Multi-color branding: ₹100-150 per piece + 18% GST
- Why? No economies of scale, high setup costs per unit

**TIER 2: Bulk / Wholesale (20+ pieces)** ✅ DATABASE PRICE
- Product price: **1x database price** (as listed)
- Single-color branding: ₹300 setup fee (₹354 with GST) OR ₹2-5/pc for >100
- Multi-color branding: ₹8-12 per piece + 18% GST
- MOQ: 20 pieces to get bulk pricing

🚨 **CRITICAL THRESHOLD:**
- **Quantity < 20** → ALWAYS charge 2x database price
- **Quantity ≥ 20** → Charge database price (bulk rate)

═══════════════════════════════════════
📊 PRICING CALCULATION EXAMPLES
═══════════════════════════════════════

**Example 1: SINGLE PIECE ORDER (Quantity < 20)**
Customer: "I need 1 medium desk organizer with my name in multi-color"
Database price: ₹390 (bulk rate for 20+ pcs)

❌ WRONG: "₹390 + ₹8 branding = ₹398"
✅ CORRECT:
- Product: ₹390 × 2 = ₹780 (2x markup for quantity < 20)
- Multi-color branding: ₹120 (retail branding rate)
- Subtotal: ₹900
- GST on branding (18%): ₹21.60
- **Total: ₹921.60**

Response: "For 1 medium desk organizer with your name 'Lakshya' in multi-color, the total is ₹922 (₹780 product + ₹142 customization including GST). Is that okay?"

**Example 2: SMALL ORDER BELOW MOQ (Quantity = 15)**
Customer: "I need 15 coasters with logo, single color"
Database price: ₹20 (bulk rate for 20+ pcs)

✅ CORRECT:
- Product: ₹20 × 2 = ₹40 per piece × 15 = ₹600 (2x markup for quantity < 20)
- Single-color branding: ₹60 per piece × 15 = ₹900 (retail branding rate)
- Subtotal: ₹1,500
- GST on branding (18%): ₹162
- **Total: ₹1,662**

**Example 3: BULK ORDER AT MOQ (Quantity = 20)**
Customer: "I need 20 coasters with logo, single color"
Database price: ₹20 (bulk rate for 20+ pcs)

✅ CORRECT:
- Product: ₹20 × 1 = ₹20 per piece × 20 = ₹400 (bulk rate, no markup)
- Single-color branding: ₹300 setup fee (for <100 pcs)
- Subtotal: ₹700
- GST on branding (18%): ₹54
- **Total: ₹754**

**Example 4: LARGE BULK ORDER (Quantity = 100)**
Customer: "100 diaries + 100 mouse pads + gift boxes + branding"
Database prices: Diary ₹135, Mouse Pad ₹90, Gift Box ₹30

✅ CORRECT:
- Diaries: ₹135 × 100 = ₹13,500 (database price, no markup)
- Mouse Pads: ₹90 × 100 = ₹9,000 (database price, no markup)
- Gift Boxes: ₹30 × 100 = ₹3,000
- Single-color branding: ₹2 × 200 pieces = ₹400
- Subtotal: ₹25,900
- GST on branding (18%): ₹72
- **Total: ₹25,972** (NOT ₹23,520!)

🚨 **CRITICAL VALIDATION RULES:**
1. If quantity < 20 → ALWAYS apply 2x markup (MANDATORY)
2. If quantity ≥ 20 → Charge database price (bulk rate)
3. NEVER quote bulk branding rates (₹2, ₹8) for quantities < 20
4. For quantities < 20 → Branding: ₹50-150/pc depending on color
5. ALWAYS calculate GST on branding (18%)
6. ALWAYS verify your math before quoting!

═══════════════════════════════════════
🖼️ IMAGE SENDING & CATALOG DELIVERY
═══════════════════════════════════════

**IMAGE SENDING:**
- ❌ NEVER proactively say "Let me show you" unless customer EXPLICITLY asks
- ❌ NEVER say "the system will send" or "images will be sent automatically" or mention "system"
- When customer asks "Do you have X?", just answer: "Yes, we have X! What's the occasion?"
- When customer says "Show me X" or "Share pictures", respond with qualification questions ONLY
- ❌ FORBIDDEN: "catalog:", "trigger:", "system:", "automatically", any technical syntax

**IMAGE RECOGNITION (When customers send photos):**
✅ Cork products → Identify: "That's our [product]! Looking for this?"
✅ Logo files → Acknowledge: "Perfect! I can quote for [quantity] [product] with your logo. Single or multi-color?"
✅ Quality issues → Sympathize: "I see the concern. Let me help resolve this. When did you receive it?"

**CATALOG REQUESTS (v50 - CRITICAL):**

When customer asks for catalog/brochure/PDF:

🚨 🚨 🚨 **ABSOLUTELY FORBIDDEN:**
❌ ❌ ❌ NEVER ask: "Please share your email"
❌ ❌ ❌ NEVER ask: "Please share your WhatsApp number"
❌ ❌ ❌ NEVER mention "email" - THEY'RE ALREADY ON WHATSAPP!

✅ ✅ ✅ **CORRECT RESPONSE:**
Customer: "Can you share your catalog?"
You: "Here's our complete cork products catalog! 🌿"

DO NOT ask qualification questions for catalog - just acknowledge briefly.
AFTER they receive catalog, THEN qualify: "What brings you to 9 Cork today?"

REMEMBER: You KNOW all products and prices. Qualify first, price later. Max 2 sentences, under 200 chars. This is WhatsApp!`;

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

    // FIX ISSUE #6: Add connection pooling limits for better scalability
    await mongoose.connect(CONFIG.MONGODB_URI, {
      maxPoolSize: 10,               // Max 10 connections in pool
      minPoolSize: 2,                // Keep 2 warm connections
      serverSelectionTimeoutMS: 5000, // 5 second timeout
      socketTimeoutMS: 45000,        // Close sockets after 45s of inactivity
      family: 4                      // Use IPv4, avoid IPv6 issues
    });
    console.log('✅ MongoDB connected with connection pooling (2-10 connections)');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Continuing without MongoDB - conversation history disabled');
    if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
  }
}

// FIX #3: MongoDB Reconnection Logic (auto-recovery from disconnects)
mongoose.connection.on('disconnected', () => {
  console.error('❌ MongoDB disconnected. Attempting to reconnect in 5 seconds...');

  setTimeout(() => {
    mongoose.connect(CONFIG.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    }).then(() => {
      console.log('✅ MongoDB reconnected successfully');
    }).catch(err => {
      console.error('❌ MongoDB reconnection failed:', err.message);
      if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
    });
  }, 5000);
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err.message);
  if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

// Initialize Redis queue (non-blocking)
async function connectQueue() {
  // Skip Redis if not configured
  if (!CONFIG.REDIS_URL || CONFIG.REDIS_URL.includes('localhost') || CONFIG.REDIS_URL === 'redis://localhost:6379') {
    console.log('⚠️  Redis not configured - messages will be processed directly');
    messageQueue = null;
    return;
  }

  try {
    // Detect if SSL is required based on URL
    const requiresSSL = CONFIG.REDIS_URL.startsWith('rediss://');

    // Build Redis config based on SSL requirement
    const redisConfig = {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false
    };

    // Only add TLS config if using rediss:// (SSL)
    if (requiresSSL) {
      // SECURITY: Always validate TLS certificates (no bypass option)
      redisConfig.tls = {
        rejectUnauthorized: true, // Always true - prevents MITM attacks
        requestCert: true,
        agent: false
      };

      console.log('🔒 Redis TLS: certificate validation ENABLED (mandatory)');
    }

    console.log(`🔧 Initializing queue with ${requiresSSL ? 'SSL (rediss://)' : 'non-SSL (redis://)'}`);

    messageQueue = new Bull('whatsapp-messages', CONFIG.REDIS_URL, {
      redis: redisConfig,
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

    console.log('✅ Message queue initialized and connected');

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
async function handleImageDetectionAndSending(from, agentResponse, messageBody, conversationContext = []) {
  try {
    // Pattern constants (defined once, used multiple times)
    // STRICT: Only words that explicitly REQUEST images, not conversational words like "have"
    // CRITICAL FIX v53: Exclude "photo frames" and "picture frames" (product names, not photo requests)
    const TRIGGER_WORDS = /\b(show|picture(?!s? frames?)|pictures(?! frames?)|photo(?!s? frames?)|photos(?! frames?)|image|images|send|share)\b/i;
    // AUTO-GENERATED from product-image-database.json v1.3 - includes ALL product keywords from 9cork.com AND homedecorzstore.com - 41 products, 123 keywords
    const PRODUCT_KEYWORDS = /(13inch|15inch|3in1|3inone|4pcs|accessory|and|aqua|bag|bifold|bohemian|box|breakfast|bridge|business|calendar|candle|card|case|catchall|chip|choco|chocochip|clutch|coaster|coasters|combo|cube|cubic|designer|desk|desktop|diamond|diaries|diary|dining|fabric|flat|for|frame|frames|fridge|grain|hanging|heart|holder|hot|inch|journal|keychain|ladies|laptop|large|leaf|light|lights|magnet|mat|men|minimalistic|mouse|mousepad|multicolor|multicolored|natural|notebook|office|organizer|pad|passport|pattern|patterned|pen|pencil|photo|picture|piece|placemat|placemats|plain|planner|plant|planter|planters|plants|pot|premium|print|round|rubberized|runner|serving|set|shaped|sleeve|small|square|stand|stationery|striped|succulent|table|tablemat|tablemats|tabletop|tea|tealight|test|testtube|texture|textured|top|tote|travel|tray|trinket|triple|trivet|trivets|tube|ushaped|wall|wallet|with|women|workspace)/i;

    // CRITICAL FIX: Only use USER message for detection, NEVER bot response
    // This prevents bot saying "Let me show you diaries" from triggering images
    let userMessage = messageBody || '';
    const hasTrigger = TRIGGER_WORDS.test(userMessage);

    // v53.4 FIX: Enhanced context-aware image detection
    // When user says generic image request OR pronouns, look at conversation history
    const pronounReferences = /\b(the same|them|it|those|these|that|above|earlier|mentioned|suggestions?)\b/i;
    // v53.7 FIX: Added typo variants (calender, organiser, etc.) to prevent wrong context matching
    const genericImageRequest = hasTrigger && !/\b(coasters?|diar(y|ies)|bags?|wallets?|planters?|desk|organiz(er|ers)|organis(er|ers)|frames?|calend[ae]rs?|pens?|notebooks?|mats?|tables?|candles?|holders?|bottles?|trays?|test.?tubes?|mousepads?)\b/i.test(userMessage);

    // v53.4 NEW: Detect generic image requests like "please share image", "share image options"
    if ((pronounReferences.test(userMessage) && hasTrigger) || genericImageRequest) {
      console.log('🔍 Generic image request or pronoun detected, checking conversation context...');
      // Look at last 10 messages to find product mentions (increased from 5)
      const recentMessages = conversationContext.slice(-10);
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        const msg = recentMessages[i];
        const content = msg.content || '';
        // Extract product keywords from recent conversation (expanded list)
        const productMatch = content.match(/\b(coaster|diary|bag|wallet|planter|desk|organizer|frame|calendar|pen|notebook|mat|table|candle|tea light|tealight|holder|test tube|testtube|bottle|tray|mousepad|mouse pad)\b/i);
        if (productMatch) {
          const productContext = productMatch[0];
          console.log(`✅ Found product context from conversation: "${productContext}"`);
          // Append product context to user message for better matching
          userMessage = `${messageBody} ${productContext}`;
          break;
        }
      }

      // v53.5 FIXED: If still no product context found, check for "options" keyword
      if (!/\b(coaster|diary|bag|wallet|planter|desk|organizer|frame|calendar)\b/i.test(userMessage) && /\b(options?|variety|suggestions?)\b/i.test(messageBody)) {
        console.log('✅ Customer asking for options/variety, triggering variety mode');
        userMessage = `${messageBody} options`; // Will match 'all' pattern → shows variety
      }
    }

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
    // v53.5 EXPANDED: Added missing product categories that were causing image sending failures
    // IMPORTANT: 'all' is checked FIRST to handle "options" and "variety" requests properly
    const catalogPatterns = {
      'all': /\b(catalog|catalogue|all products|full range|variety|options)\b/i,  // CHECK FIRST! Added "variety" and "options"
      'coasters': /\b(coasters?|coaster collection)\b/i,
      'diaries': /\b(diary|diaries|notebook|notebooks)\b/i,
      'desk': /\b(desk|organizers?|pen holder|pencil holder)\b/i,
      'bags': /\b(bags?|wallets?|laptop|clutch|tote)\b/i,
      'planters': /\b(planters?|test tube|testtube)\b/i,
      'trays': /\b(trays?|serving)\b/i,
      'bottles': /\b(bottles?|water bottle)\b/i,
      'frames': /\b(frames?|photo frames?|picture frames?)\b/i,
      'calendar': /\b(calend[ae]rs?|table calendar|wall calendar|desk calendar)\b/i,  // v53.6: Added typo "calender"
      'mousepad': /\b(mousepad|mouse pad|mousepads)\b/i,  // ADDED - was missing!
      'candles': /\b(candles?|tea ?lights?|tealights?|candle holder)\b/i  // ADDED - was missing!
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
      // Initialize sent images tracker for this phone number
      if (!sentImagesTracker.has(from)) {
        sentImagesTracker.set(from, new Set());
      }
      const sentImages = sentImagesTracker.get(from);

      // First try: Get new products excluding already sent
      let products = await findProductsByCategory(catalogCategory, 10, from, true);

      // If no new products, check if we have any products at all
      if (products.length === 0) {
        const allProducts = await findProductsByCategory(catalogCategory, 10, from, false);
        if (allProducts.length > 0) {
          // We have products but all were already sent
          console.log(`⚠️ All ${catalogCategory} images already sent to ${from}`);
          await sendWhatsAppMessage(from, "I've already shared all available images for this category. Would you like to see a different product category?").catch(() => {});
          return; // Exit early
        }

        // v53.7 CRITICAL: If category doesn't exist in our catalog, exit without sending wrong images
        // Let AI handle with Rule 5C ("We don't have X, would you like Y instead?")
        const nonExistentCategories = ['mousepad', 'candles']; // Products we don't have (removed 'calendar' - now in stock!)
        if (nonExistentCategories.includes(catalogCategory)) {
          console.log(`⚠️ Category '${catalogCategory}' doesn't exist in our catalog`);
          console.log(`   AI will suggest alternatives via Rule 5C`);
          return; // Exit early, don't send wrong images!
        }
        // Else: no products found at all, continue to fallback for other categories
      }

      if (products.length > 0) {
        console.log(`📚 Sending ${products.length} ${catalogCategory} images from MongoDB`);

        let sentCount = 0;
        let failedCount = 0;
        for (let i = 0; i < products.length; i++) {
          const product = products[i];
          console.log(`   [${i+1}/${products.length}] Processing: ${product.name}`);

          if (!product.images || product.images.length === 0) {
            console.log(`   ⚠️ No images for ${product.name}`);
            continue;
          }

          try {
            const originalUrl = product.images[0];
            const imageUrl = convertGoogleDriveUrl(originalUrl);
            console.log(`   📸 Image URL: ${imageUrl.substring(0, 60)}...`);

            if (!isValidImageUrl(imageUrl)) {
              console.log(`   ❌ Invalid URL: ${imageUrl}`);
              failedCount++;
              continue;
            }

            await sendWhatsAppImage(from, imageUrl, `${product.name} 🌿`);
            sentImages.add(originalUrl); // Track sent image
            sentCount++;
            console.log(`   ✅ Sent: ${product.name} (${sentCount}/${products.length})`);
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (err) {
            failedCount++;

            // Check for specific error types
            const errorMsg = err.message || '';
            const errorData = err.response?.data;

            // WhatsApp 5MB size limit error
            if (errorMsg.includes('Image too large') || errorMsg.includes('131053')) {
              console.error(`   ⚠️ Image too large (>5MB), skipping: ${product.name}`);
              console.error(`   💡 Tip: Compress this image in source file`);
            }
            // Google Drive redirect issues
            else if (errorMsg.includes('303') || errorMsg.includes('redirect')) {
              console.error(`   ⚠️ Google Drive redirect issue: ${product.name}`);
              console.error(`   💡 Tip: Use direct image URLs instead of Drive links`);
            }
            // Generic error
            else {
              console.error(`   ❌ Failed to send ${product.name}:`, err.message);
              if (errorData) console.error(`   Error details:`, errorData);
            }
          }
        }

        // Error handling
        if (failedCount > 0) {
          console.log(`📊 Final result: ${sentCount} sent, ${failedCount} failed`);
          if (sentCount === 0) {
            await sendWhatsAppMessage(from, `I'm having trouble sending images right now. Some images are too large for WhatsApp. Would you like product descriptions instead?`).catch(() => {});
          } else if (failedCount > sentCount) {
            // More failed than succeeded - mention the issue
            await sendWhatsAppMessage(from, `I sent ${sentCount} images. ${failedCount} others couldn't be sent (too large for WhatsApp's 5MB limit). Would you like to see more product options or get descriptions?`).catch(() => {});
          } else {
            // Some failures but mostly succeeded
            await sendWhatsAppMessage(from, `I sent ${sentCount} images. A few couldn't be delivered due to file size. Let me know if you need more options!`).catch(() => {});
          }
        }
      } else {
        // Fallback to old JSON system if MongoDB is empty
        console.log('⚠️ No products in MongoDB, using JSON fallback');
        const catalogImages = getCatalogImages(catalogCategory);
        console.log(`📚 Sending ${catalogImages.length} ${catalogCategory} images from JSON`);

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

        if (failedCount > 0) {
          if (sentCount === 0) {
            await sendWhatsAppMessage(from, `I'm having trouble sending images right now. Let me describe our ${catalogCategory} instead - would that help?`).catch(() => {});
          } else {
            await sendWhatsAppMessage(from, `Note: I sent ${sentCount} images but ${failedCount} couldn't be delivered. Let me know if you'd like descriptions instead.`).catch(() => {});
          }
        }
      }
    } else if (hasTrigger && PRODUCT_KEYWORDS.test(userMessage)) {
      // v53.2 FIX: Exclude non-product keywords (packaging, box, etc.)
      // Customer asking for "photo of the box" should NOT trigger product image search
      const NON_PRODUCT_KEYWORDS = /\b(box|boxes|packaging|packing|outer|inner|wrapper|cover|carton)\b/i;

      if (NON_PRODUCT_KEYWORDS.test(userMessage)) {
        console.log('⚠️ Customer asking about packaging/non-product item, skipping random product search');
        console.log('   AI will respond naturally without sending irrelevant product images');
        // Don't send any images - let AI respond naturally
        // AI will say something like "I don't have gift box images, but I can describe it"
        return;
      }

      // Single product image - Try MongoDB first
      const products = await findProductBySearch(userMessage, 1);

      if (products.length > 0 && products[0].images && products[0].images.length > 0) {
        console.log(`📸 Found product in MongoDB: ${products[0].name}`);
        try {
          const imageUrl = convertGoogleDriveUrl(products[0].images[0]);
          if (isValidImageUrl(imageUrl)) {
            await sendWhatsAppImage(from, imageUrl, `${products[0].name} 🌿`);
          }
        } catch (err) {
          console.error('❌ Image send failed:', err.response?.data || err.message);
        }
      } else {
        // Fallback to old JSON system
        console.log('⚠️ Product not found in MongoDB, using JSON fallback');
        const productImage = findProductImage(userMessage);
        if (productImage && isValidCorkProductUrl(productImage)) {
          try {
            await sendWhatsAppImage(from, productImage, 'Here\'s what it looks like! 🌿');
          } catch (err) {
            console.error('❌ Image send failed:', err.response?.data || err.message);
          }
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
      // v52 FIX: Check if we already sent a response to this message successfully
      // Prevents queue retries from sending duplicate responses
      if (sentResponses.has(messageId)) {
        const previousResponse = sentResponses.get(messageId);
        console.log(`✅ Message ${messageId} already processed successfully at ${previousResponse.timestamp.toISOString()}`);
        console.log(`   Skipping resend (queue retry detected)`);
        return; // Skip this job, message was already sent
      }

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

      // v52 FIX: Mark message as successfully sent to prevent queue retries from resending
      sentResponses.set(messageId, {
        timestamp: new Date(),
        responseText: agentResponse.substring(0, 100), // Store first 100 chars for logging
        phoneNumber: from
      });
      console.log(`✅ Marked message ${messageId} as sent successfully`);

      // Handle image detection and sending (SHARED FUNCTION - works for both queue and direct paths)
      // v42: Pass conversation context for pronoun resolution
      await handleImageDetectionAndSending(from, agentResponse, messageBody, context);

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

// Rate limiting middleware (SECURITY: Reduced from 100 to 30 req/min)
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 requests per minute (prevents DDoS)
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Monitoring endpoints rate limiter (more permissive for health checks)
const monitoringLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 requests per minute (allows monitoring tools)
  message: 'Too many monitoring requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// FIX #4: Per-Phone Rate Limiting (prevents spam from individual users)
const phoneRateLimits = new Map();

// v49: Message deduplication cache (prevent processing same message twice)
// Meta sometimes sends duplicate webhooks for reliability - causes duplicate AI responses
const processedMessageIds = new Set();
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes

// v52 FIX: Track successfully sent responses to prevent queue retries from resending
// When Bull queue retries a failed job, it must NOT resend if message was already sent
const sentResponses = new Map(); // Map<messageId, { timestamp: Date, responseText: string }>

// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  const cleanupAge = 5 * 60 * 1000; // 5 minutes

  // Clean up rate limit timestamps
  for (const [phone, timestamp] of phoneRateLimits.entries()) {
    if (now - timestamp > cleanupAge) {
      phoneRateLimits.delete(phone);
    }
  }

  // v49: Clean up message deduplication cache
  if (processedMessageIds.size > 500) {
    console.log(`🧹 Clearing message deduplication cache (${processedMessageIds.size} entries)`);
    processedMessageIds.clear();
  }
}, 5 * 60 * 1000);

function checkPhoneRateLimit(phoneNumber, messageContent = '') {
  const now = Date.now();
  const lastMessage = phoneRateLimits.get(phoneNumber) || 0;

  // UX FIX v41: Only block ACTUAL spam (multiple messages within 500ms)
  // Normal typing/impatience is OK - don't punish customers!
  const minInterval = 500; // 0.5 seconds - only catches true spam

  if (now - lastMessage < minInterval) {
    const timeSinceLastMs = now - lastMessage;
    console.warn(`⚠️ Possible spam detected for ${phoneNumber} - ${timeSinceLastMs}ms since last message`);

    // ALWAYS silently drop - NEVER send rude "Please wait" messages
    console.log(`💡 Silently dropping rapid message: "${messageContent.substring(0, 50)}..."`);
    return 'silent_drop';
  }

  // Update last message time
  phoneRateLimits.set(phoneNumber, now);
  return true;
}

// Webhook signature validation middleware (SECURE - timing attack protected)
function validateWebhookSignature(req, res, next) {
  // SECURITY FIX: Fail-fast in production if app secret not configured
  if (!CONFIG.WHATSAPP_APP_SECRET) {
    if (CONFIG.NODE_ENV === 'production') {
      console.error('❌ FATAL: WHATSAPP_APP_SECRET required in production for webhook security');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }
    // Only allow bypass in development mode
    console.warn('⚠️ WARNING: Webhook signature validation disabled (development mode)');
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];

  if (!signature) {
    console.warn('⚠️ No signature provided in webhook request');
    return res.sendStatus(401);
  }

  // CRITICAL FIX v47: Use raw body (not re-stringified JSON) for signature validation
  // Meta/Facebook calculates signature on RAW request bytes
  const bodyToVerify = req.rawBody || JSON.stringify(req.body);

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', CONFIG.WHATSAPP_APP_SECRET)
    .update(bodyToVerify)
    .digest('hex');

  // SECURITY FIX: Use timing-safe comparison to prevent timing attacks
  try {
    const signatureBuffer = Buffer.from(signature.replace('sha256=', ''), 'hex');
    const expectedBuffer = Buffer.from(expectedSignature.replace('sha256=', ''), 'hex');

    if (signatureBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      // Enhanced logging for debugging (v47)
      console.error('❌ Invalid webhook signature');
      console.error('   Received signature:', signature.substring(0, 20) + '...');
      console.error('   Expected signature:', expectedSignature.substring(0, 20) + '...');
      console.error('   Body length:', bodyToVerify.length, 'bytes');
      console.error('   Using rawBody:', !!req.rawBody);
      return res.sendStatus(403);
    }
  } catch (err) {
    console.error('❌ Signature validation error:', err.message);
    return res.sendStatus(403);
  }

  console.log('✅ Webhook signature validated successfully');
  next();
}

// FIX #2: Input Validation Function (prevents crashes from malformed messages)
function validateWhatsAppMessage(message) {
  try {
    // Validate phone number format (10-15 digits)
    if (!message.from || !/^\d{10,15}$/.test(message.from)) {
      return { valid: false, error: 'Invalid phone number format' };
    }

    // Validate message type
    const validTypes = ['text', 'image', 'audio', 'video', 'document', 'sticker'];
    if (!message.type || !validTypes.includes(message.type)) {
      return { valid: false, error: `Unsupported message type: ${message.type}` };
    }

    // Validate message content exists
    const body = message.text?.body || message.image?.caption || '';

    // Prevent DOS attacks - max message length
    if (body.length > 4096) {
      return { valid: false, error: 'Message too long (max 4096 characters)' };
    }

    // Sanitize HTML/scripts from message
    const sanitized = body.replace(/<[^>]*>/g, '').trim();

    // Additional checks for image messages
    if (message.type === 'image') {
      if (!message.image?.id && !message.image?.url) {
        return { valid: false, error: 'Image message missing media ID or URL' };
      }
    }

    return { valid: true, sanitized, body: sanitized || body };
  } catch (error) {
    console.error('Error in validateWhatsAppMessage:', error);
    return { valid: false, error: 'Validation error' };
  }
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
      const from = message.from;
      const messageBody = message.text?.body || message.image?.caption || '';
      const messageType = message.type;
      const messageId = message.id;
      const mediaId = message.image?.id;

      // FIX #7: Add request ID for tracking
      const requestId = generateRequestId();
      console.log(`[${requestId}] 📨 Incoming webhook from ${from} (${messageType})`);

      // v49: Message deduplication - prevent processing same message twice
      // Meta sometimes sends duplicate webhooks → causes bot to send multiple different responses
      if (processedMessageIds.has(messageId)) {
        console.log(`[${requestId}] 🔄 Duplicate message detected (already processed) - skipping`);
        return; // Skip duplicate message
      }
      processedMessageIds.add(messageId);
      console.log(`[${requestId}] ✅ Message ${messageId} marked as processing (cache size: ${processedMessageIds.size})`);

      // FIX #2: Validate message before processing
      const validation = validateWhatsAppMessage(message);
      if (!validation.valid) {
        console.warn(`[${requestId}] ❌ Invalid message: ${validation.error}`);
        return; // Skip processing invalid messages
      }

      // FIX #4: Check rate limit (v41 - NEVER sends rude messages, only blocks true spam)
      const rateLimitCheck = checkPhoneRateLimit(from, messageBody);

      if (rateLimitCheck === 'silent_drop') {
        // Rapid message detected (<500ms) - silently ignore, NO rude message sent
        console.log(`[${requestId}] 💡 Silently dropping rapid message (${messageBody.length} chars)`);
        return;
      }

      console.log(`[${requestId}] 📱 Valid message: ${messageBody || '[IMAGE]'}`);

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

          // v52 FIX: Check if already sent (same check as queue processor)
          if (sentResponses.has(messageId)) {
            const previousResponse = sentResponses.get(messageId);
            console.log(`✅ Message ${messageId} already sent at ${previousResponse.timestamp.toISOString()}`);
            return; // Skip duplicate processing
          }

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
            // v42: Pass conversation context for pronoun resolution
            await handleImageDetectionAndSending(from, response, messageBody, context);

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
    // Sanitize inputs to prevent NoSQL injection
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
    const sanitizedMessage = sanitizeMessageContent(message);

    // Find or create customer
    let customer = await Customer.findOne({ phoneNumber: { $eq: sanitizedPhone } });
    if (!customer) {
      customer = new Customer({
        phoneNumber: sanitizedPhone,
        lastContactedAt: new Date()
      });
      await customer.save();
    } else {
      customer.lastContactedAt = new Date();
      await customer.save();
    }

    // Find or create conversation
    let conversation = await Conversation.findOne({
      customerPhone: { $eq: sanitizedPhone },
      status: 'active'
    });

    if (!conversation) {
      conversation = new Conversation({
        customerPhone: sanitizedPhone
      });
    }

    // Add message (use sanitized message)
    await conversation.addMessage('customer', sanitizedMessage, messageId);

    console.log('✅ Customer message stored in database');
  } catch (error) {
    console.error('❌ Error storing customer message:', error);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
  }
}

// Store agent message in database
async function storeAgentMessage(phoneNumber, message) {
  try {
    // Sanitize inputs to prevent NoSQL injection
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
    const sanitizedMessage = sanitizeMessageContent(message);

    const conversation = await Conversation.findOne({
      customerPhone: { $eq: sanitizedPhone },
      status: 'active'
    });

    if (conversation) {
      await conversation.addMessage('agent', sanitizedMessage);
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
    // Sanitize phone number to prevent NoSQL injection
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    // STRATEGY: Check in-memory FIRST (most recent, fastest)
    // Then fall back to MongoDB if in-memory is empty

    // Step 1: Check in-memory cache first (fastest and most up-to-date)
    if (conversationMemory.has(sanitizedPhone)) {
      const memoryMessages = conversationMemory.get(sanitizedPhone);
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
        customerPhone: { $eq: sanitizedPhone },
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
          // SECURITY FIX: Use sanitizedPhone consistently for Map keys
          if (!conversationMemory.has(sanitizedPhone)) {
            conversationMemory.set(sanitizedPhone, recentMessages.map(msg => ({
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
    // SECURITY FIX: Use sanitizedPhone consistently for Map keys
    try {
      const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
      if (conversationMemory.has(sanitizedPhone)) {
        const memoryMessages = conversationMemory.get(sanitizedPhone);
        const recentMemory = memoryMessages.slice(-50);
        console.log(`💾 EMERGENCY FALLBACK: Retrieved ${recentMemory.length} messages from in-memory cache`);
        return recentMemory.map(msg => ({
          role: msg.role,
          content: msg.content
        }));
      }
    } catch (sanitizeError) {
      // If sanitization fails in error handler, just return empty
      console.error('⚠️ Phone sanitization failed in fallback');
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

    // SECURITY FIX: Sanitize phone number consistently for Map keys
    const sanitizedPhone = sanitizePhoneNumber(customerPhone);

    // Sanitize message to prevent prompt injection attacks
    const sanitizedMessage = sanitizeAIPrompt(message);

    // Detect suspicious input patterns
    if (detectSuspiciousInput(message)) {
      console.warn('⚠️ Suspicious input detected - potential attack attempt');
      // Log security event but still process (sanitized version)
    }

    // CRITICAL: Add current message to context for AI processing
    // context already has history, we just need to add the new user message
    const fullContext = [...context, { role: 'user', content: sanitizedMessage }];

    // ALSO store in conversationMemory for in-memory fallback (in case MongoDB fails)
    // SECURITY FIX: Use atomic operation to prevent race condition
    if (!conversationMemory.has(sanitizedPhone)) {
      conversationMemory.set(sanitizedPhone, []);
    }
    const customerMemory = conversationMemory.get(sanitizedPhone);
    customerMemory.push({
      role: 'user',
      content: sanitizedMessage,
      timestamp: new Date()
    });

    // Use multi-provider AI manager with automatic failover
    // Send last 50 messages for context (optimized for Groq upper tier 32k+ token limit)
    const result = await aiManager.getResponse(
      SYSTEM_PROMPT,
      fullContext.slice(-50), // Last 50 messages (including new message)
      sanitizedMessage
    );

    console.log(`✅ Response from ${result.provider.toUpperCase()}: ${result.response.substring(0, 100)}...`);

    // Store AI response in in-memory cache
    customerMemory.push({
      role: 'assistant',
      content: result.response,
      timestamp: new Date()
    });

    // Limit in-memory cache to last 20 messages per customer
    if (customerMemory.length > 20) {
      conversationMemory.set(sanitizedPhone, customerMemory.slice(-20));
    }

    return result.response;

  } catch (error) {
    console.error('❌ Error in AI processing:', error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);

    // Ultimate fallback (should rarely happen since aiManager has its own fallbacks)
    return "Thank you for your message! We're experiencing technical difficulties. Please try again in a moment, or let me know what you're looking for and I'll help! 🌿";
  }
}


// Send WhatsApp message
async function sendWhatsAppMessage(to, text) {
  try {
    // Clean token - remove ALL whitespace and control characters
    const cleanToken = CONFIG.WHATSAPP_TOKEN.replace(/[\r\n\t\s]/g, '');

    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
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

// Send WhatsApp image using Media Upload API with fallback to direct URL
async function sendWhatsAppImage(to, imageUrl, caption = '') {
  try {
    console.log(`📸 Attempting Media Upload API: ${imageUrl.slice(0, 50)}...`);

    // PRIMARY: Try WhatsApp Media Upload API (100% reliable)
    const result = await uploadAndSendImage(to, imageUrl, caption);

    if (result.success) {
      console.log('✅ Image sent successfully via Media Upload API');
      return result.response;
    } else {
      console.log('⚠️ Media Upload failed, trying direct URL fallback...');
    }
  } catch (uploadError) {
    console.log('⚠️ Media Upload error, trying direct URL fallback:', uploadError.message);
  }

  // FALLBACK: Use direct URL method (original method)
  try {
    console.log('📸 Sending via direct URL fallback');
    const cleanToken = CONFIG.WHATSAPP_TOKEN.replace(/[\r\n\t\s]/g, '');
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: { link: imageUrl, caption: caption }
      },
      { headers: { 'Authorization': `Bearer ${cleanToken}`, 'Content-Type': 'application/json' } }
    );
    console.log('✅ Image sent successfully via direct URL fallback');
    return response.data;
  } catch (error) {
    console.error('❌ Both image sending methods failed:', error.response?.data || error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
    throw error;
  }
}

// Send WhatsApp document (PDF, DOC, etc.)
async function sendWhatsAppDocument(to, documentUrl, filename, caption = '') {
  try {
    const cleanToken = CONFIG.WHATSAPP_TOKEN.replace(/[\r\n\t\s]/g, '');
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
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
      `https://graph.facebook.com/v21.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
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

// Health check endpoint (SECURITY: Rate limited to 60 req/min)
app.get('/health', monitoringLimiter, async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: 'ROBUST-v34-CRITICAL-FIXES-COMPLETE',
    groqKeys: aiManager.groqClients ? aiManager.groqClients.length : 0,
    services: {
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      queue: messageQueue ? 'active' : 'inactive'
    }
  };

  res.json(health);
});

// Stats endpoint (SECURITY: Rate limited to 60 req/min)
app.get('/stats', monitoringLimiter, async (req, res) => {
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

// Admin endpoint: Clear all products from database
app.post('/admin/clear-products', async (req, res) => {
  try {
    console.log('📥 Admin clear endpoint called');

    // Simple authentication using VERIFY_TOKEN
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token !== CONFIG.VERIFY_TOKEN) {
      console.log('❌ Unauthorized access attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('🗑️  Clearing all products from database...');

    // Delete all products
    const deleteResult = await Product.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} products`);

    res.json({
      success: true,
      deleted: deleteResult.deletedCount,
      message: 'All products cleared from database'
    });

  } catch (error) {
    console.error('❌ Clear products failed:', error);
    res.status(500).json({
      error: 'Clear failed',
      message: error.message
    });
  }
});

// Admin endpoint: Import products (one-time setup)
app.post('/admin/import-products', async (req, res) => {
  try {
    console.log('📥 Admin import endpoint called');

    // Simple authentication using VERIFY_TOKEN
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token !== CONFIG.VERIFY_TOKEN) {
      console.log('❌ Unauthorized access attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('📦 Starting product import from admin endpoint...');

    // Clear require cache to get fresh JSON file
    delete require.cache[require.resolve('./scripts/products-data.json')];

    // Load products from JSON file (fresh, not cached)
    const productsData = require('./scripts/products-data.json');
    console.log(`📖 Loaded ${productsData.length} products from JSON`);

    // Clear existing products FIRST
    const deleteResult = await Product.deleteMany({});
    console.log(`🗑️  Deleted ${deleteResult.deletedCount} existing products`);

    // Insert products (ordered: false allows partial success)
    await Product.insertMany(productsData, { ordered: false });
    console.log(`✅ Inserted ${productsData.length} products`);

    // Get category summary
    const categories = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const totalCount = await Product.countDocuments();

    res.json({
      success: true,
      imported: productsData.length,
      totalInDatabase: totalCount,
      categories: categories.map(c => ({ category: c._id, count: c.count }))
    });

  } catch (error) {
    console.error('❌ Product import failed:', error);
    res.status(500).json({
      error: 'Import failed',
      message: error.message
    });
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
  console.log(`📊 Stats: http://localhost:${CONFIG.PORT}/stats`);
  console.log(`📦 Admin import: http://localhost:${CONFIG.PORT}/admin/import-products\n`);

  // Connect to services in the background (non-blocking)
  console.log('🔄 Connecting to databases...');
  connectDatabase().catch(err => console.error('Database connection failed:', err));
  connectQueue().catch(err => console.error('Queue connection failed:', err));
});

// FIX #5: Memory Cleanup (prevents memory leaks from old conversations)
setInterval(() => {
  const now = Date.now();
  const TTL = 60 * 60 * 1000; // 1 hour time-to-live

  let cleaned = 0;
  for (const [phone, messages] of conversationMemory.entries()) {
    if (messages.length === 0) {
      // Empty conversation, remove it
      conversationMemory.delete(phone);
      cleaned++;
      continue;
    }

    // Check last message timestamp
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.timestamp) {
      const age = now - new Date(lastMessage.timestamp).getTime();
      if (age > TTL) {
        conversationMemory.delete(phone);
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Memory cleanup: Removed ${cleaned} old conversations`);
  }

  // Clean up sent images tracker for inactive conversations
  let imagesCleaned = 0;
  for (const phone of sentImagesTracker.keys()) {
    if (!conversationMemory.has(phone)) {
      sentImagesTracker.delete(phone);
      imagesCleaned++;
    }
  }

  if (imagesCleaned > 0) {
    console.log(`🧹 Memory cleanup: Removed ${imagesCleaned} image trackers`);
  }

  // Log memory stats
  const totalConversations = conversationMemory.size;
  const memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  console.log(`📊 Active conversations: ${totalConversations}, Memory: ${memoryMB}MB, Image trackers: ${sentImagesTracker.size}`);
}, 30 * 60 * 1000); // Every 30 minutes

// Initial cleanup after 5 minutes
setTimeout(() => {
  console.log('🧹 Running initial memory cleanup...');
  const initialSize = conversationMemory.size;
  console.log(`📊 Initial conversation memory: ${initialSize} entries`);
}, 5 * 60 * 1000);
