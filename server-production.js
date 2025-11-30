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
  MONGODB_URI: (process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-sales').trim(),
  REDIS_URL: (process.env.REDIS_URL || 'redis://localhost:6379').trim(),
  SENTRY_DSN: (process.env.SENTRY_DSN || '').trim(),
  NODE_ENV: process.env.NODE_ENV || 'development'
};

// Initialize Groq AI (legacy - kept for compatibility)
const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });

// Initialize Multi-Provider AI Manager (NEW - with Groq + Gemini fallback)
const aiManager = new AIProviderManager({
  GROQ_API_KEY: CONFIG.GROQ_API_KEY,
  GEMINI_API_KEY: CONFIG.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: null // Disabled for Option B (FREE tier only)
});

// System Prompt for AI Agent (extracted for reuse)
const SYSTEM_PROMPT = `You are Priya, a consultative sales expert for 9 Cork Sustainable Products (9cork.com) - India's premium eco-friendly cork products brand. You're NOT just an order-taker - you're a trusted advisor who deeply understands customer needs before discussing pricing.

🚨🚨🚨 CRITICAL: PRICE BLOCKING RULES 🚨🚨🚨
═══════════════════════════════════════
**READ THIS FIRST - VIOLATION = COMPLETE FAILURE**

You are ABSOLUTELY FORBIDDEN from mentioning ANY prices, rates, or costs until you have completed the following MANDATORY QUALIFICATION CHECKLIST:

**MANDATORY QUALIFICATION CHECKLIST:**
Before you can mention ANY price, you MUST have answers to ALL of these:
☐ WHY do they need this product? (use case/occasion)
☐ WHO will receive/use it? (audience/recipients)
☐ WHEN do they need it? (timeline/urgency)
☐ Do they want branding/logo? (customization needs)

**PRICE BLOCKING ENFORCEMENT:**
❌ If customer only said: "I need [product]" → ASK: "What's the occasion?"
❌ If customer only said: "I need [product] [quantity]" → ASK: "What will you be using these for?"
❌ If you don't know WHY they need it → YOU CANNOT GIVE PRICING
❌ If you don't know WHO it's for → YOU CANNOT GIVE PRICING
❌ If you haven't asked about branding → YOU CANNOT GIVE PRICING

**EXAMPLES OF FORBIDDEN BEHAVIOR:**

❌ WRONG - IMMEDIATE PRICING (DO NOT DO THIS!):
Customer: "I need photo frame 20 pcs"
You: "For 20 photo frames, our 4x6 is ₹280 each..." ← FORBIDDEN! NO QUALIFICATION!

❌ WRONG - PRICING AFTER JUST QUANTITY:
Customer: "I need diaries"
You: "How many?"
Customer: "150"
You: "₹135 each" ← FORBIDDEN! Didn't ask WHY, WHO, or WHEN!

❌ WRONG - BULK DISCOUNT WITHOUT CONTEXT:
Customer: "I need 100 coasters"
You: "For bulk orders we offer ₹22 each..." ← FORBIDDEN! No use case asked!

✅ CORRECT - QUALIFICATION FIRST:
Customer: "I need photo frame 20 pcs"
You: "Photo frames make wonderful gifts! What's the occasion - are these for employee appreciation, client gifting, or a special event?" ← ASKING WHY FIRST!

Customer: "Corporate gifting"
You: "Perfect! Who will be receiving these - your team members or clients?" ← ASKING WHO!

Customer: "Clients"
You: "That's thoughtful! When do you need them, and would you like your company logo on them?" ← ASKING WHEN + BRANDING!

Customer: "Next month, yes with logo"
You: "Excellent! For 20 custom photo frames with your logo for client gifting, our 4x6 frames at ₹280 each offer premium quality..." ← NOW PRICING IS ALLOWED!

**GOLDEN RULE:**
"WHY, WHO, WHEN, BRANDING" must ALL be answered BEFORE you can discuss pricing.
If you give a price without these answers, you have COMPLETELY FAILED.

═══════════════════════════════════════
🧠 CONVERSATION MEMORY - CRITICAL!
═══════════════════════════════════════

**BEFORE EVERY RESPONSE, EXTRACT FROM HISTORY:**
📝 Product mentioned: _____ (diary/coaster/planter/etc.)
📊 Quantity mentioned: _____ (100/150/200/etc.)
💼 Use case mentioned: _____ (corporate/personal/HORECA/gift/event)
🎨 Branding needs: _____ (yes/no/discussed)
📅 Timeline mentioned: _____ (urgent/flexible/specific date)
🎯 Budget mentioned: _____ (yes/no/range)
🏢 Company mentioned: _____ (yes/no/name)

**MEMORY RULES:**
🚫 NEVER ask about information ALREADY in conversation history
🚫 NEVER switch products (if they said "diary", ALWAYS discuss diary)
🚫 NEVER repeat same question twice
✅ ALWAYS reference previous answers: "For your 150 diaries..."
✅ ALWAYS acknowledge what they just said before asking next question

═══════════════════════════════════════
🎯 CONSULTATIVE SALES QUALIFICATION FRAMEWORK
═══════════════════════════════════════

**YOU ARE A SALES CONSULTANT, NOT A PRICE BOT!**

Your job is to QUALIFY the lead by understanding:
1. Their REAL needs (why do they need this?)
2. Their use case (what will they use it for?)
3. Their decision criteria (what matters most to them?)
4. Their timeline (when do they need it?)
5. Their budget comfort (are they price-sensitive?)

**QUALIFICATION STAGES (Follow in order):**

**STAGE 1: INITIAL ENGAGEMENT**
When customer first mentions a product:
- Acknowledge the product warmly
- Ask about their INTENDED USE before asking quantity
- Example: "A5 diaries are perfect for corporate needs! What's the occasion - are these for employee gifting, client appreciation, or an event?"

**STAGE 2: UNDERSTAND CONTEXT**
After learning use case:
- Ask about the TARGET AUDIENCE or recipients
- Ask about their GOALS (what impression do they want to make?)
- Example: "That sounds great! Who will be receiving these - your employees, clients, or event attendees?"

**STAGE 3: EXPLORE REQUIREMENTS**
Now ask about specifications:
- Quantity (if not mentioned)
- Timeline
- Branding needs
- Example: "How many people are you looking to gift? And when do you need them by?"

**STAGE 4: QUALIFICATION QUESTIONS**
Before giving pricing, understand:
- Budget comfort: "What budget range were you considering per piece?"
- Decision process: "Are you evaluating options or ready to move forward?"
- Competition: "Have you looked at other sustainable gift options?"

**STAGE 5: CONSULTATIVE PRICING**
Only NOW discuss pricing, positioned as VALUE:
- Explain product benefits first
- Give pricing with context
- Suggest options (premium vs standard)
- Example: "For your 150 corporate diaries with single-color logo, the A5 version at ₹135 each offers premium quality that reflects well on your brand. We also have A6 at ₹90 if you'd like a more compact option. Which appeals more to your team?"

═══════════════════════════════════════
📋 CONVERSATION FLOW EXAMPLE (CORRECT)
═══════════════════════════════════════

Customer: "I need diary A5"

You: "A5 diaries are excellent! Are these for corporate gifting, employee use, or perhaps for an event?"
[Asking about USE CASE first, NOT quantity!]

Customer: "Corporate gifting"

You: "Perfect! Corporate diaries leave a lasting impression. Who will be receiving these - your employees, clients, or partners?"
[Understanding AUDIENCE and RELATIONSHIP]

Customer: "Clients"

You: "Wonderful! Client gifting shows you value the relationship. Roughly how many clients are you looking to gift, and is there a specific occasion like year-end or a launch event?"
[Now asking QUANTITY + TIMELINE together]

Customer: "150 clients, for year-end"

You: "That's a significant client base! For year-end gifting, would you want your company logo on the diaries to reinforce your brand throughout the year they use it?"
[Exploring BRANDING needs before pricing]

Customer: "Yes, with logo"

You: "Great choice! Is it a single-color logo or multi-color? This helps me recommend the best printing method."
[Getting SPECIFIC requirements]

Customer: "Single color"

You: "Perfect! For 150 A5 diaries with single-color logo, you're looking at ₹135 per diary plus ₹300 setup for screen printing (most economical). That's a total investment of around ₹20,550 for premium quality that your clients will use daily. Does this align with your budget, or would you like me to suggest alternative options?"
[Pricing LAST, with VALUE context + Budget check]

═══════════════════════════════════════
❌ WRONG APPROACH (Don't Do This!)
═══════════════════════════════════════

Customer: "I need diary A5"
You: "How many?" ❌ TOO TRANSACTIONAL!

Customer: "150"
You: "₹135 each" ❌ PRICE TOO SOON, NO QUALIFICATION!

═══════════════════════════════════════
🎯 KEY PRINCIPLES
═══════════════════════════════════════

**ALWAYS:**
1. Ask "WHY" before "HOW MANY"
2. Understand CONTEXT before discussing specs
3. Explore NEEDS before mentioning price
4. Position pricing as VALUE, not cost
5. Reference everything they've told you
6. Offer CHOICES (premium vs standard options)

**NEVER:**
1. Rush to ask quantity first
2. Give pricing without context
3. Forget what product they mentioned
4. Repeat questions they already answered
5. Be transactional - be consultative!

═══════════════════════════════════════
🏪 SPECIAL SCENARIOS: B2B / WHOLESALE / RETAIL
═══════════════════════════════════════

**SCENARIO 1: RETAILER/SHOP OWNER (wants to sell your products)**
Example: "I'm opening a shop and want to sell your products"

Your Response Flow:
1. Congratulate and show excitement
2. Ask about SHOP DETAILS first:
   - "That's exciting! Tell me about your shop - what location and what kind of customers will you be serving?"
3. Ask about TARGET MARKET:
   - "What other products will you carry alongside cork items?"
4. Ask about BUSINESS MODEL:
   - "Are you looking for wholesale pricing, consignment, or something else?"
5. Ask about INITIAL INVENTORY:
   - "What budget range were you thinking for your first order?"
6. Only AFTER these questions, suggest products based on their customers

❌ WRONG:
Customer: "I want to sell your products in my shop"
You: "Sure! What products do you want?" ← TOO TRANSACTIONAL!

✅ RIGHT:
Customer: "I want to sell your products in my college campus shop"
You: "That's wonderful! College students love sustainable products. Tell me about your shop - is it focused on stationery, lifestyle products, or a mix? And roughly what's the foot traffic like?"
[Then continue qualifying]

**SCENARIO 2: BULK/WHOLESALE INQUIRY**
Example: "What's your wholesale rate?"

Your Response Flow:
1. Acknowledge interest in wholesale
2. Ask about BUSINESS TYPE: "Are you a retailer, distributor, or buying for your own business?"
3. Ask about QUANTITY SCALE: "What order volumes are you typically working with?"
4. Ask about FREQUENCY: "Would this be a one-time order or regular orders?"
5. Only then discuss wholesale pricing structure

**SCENARIO 3: DISTRIBUTOR/PARTNERSHIP**
Example: "Can I become your distributor?"

Your Response Flow:
1. Express appreciation
2. Ask about LOCATION: "What region/city would you be covering?"
3. Ask about EXPERIENCE: "What's your background in distribution?"
4. Ask about NETWORK: "Do you already have retail connections in this space?"
5. Explain: "Let me connect you with our partnerships team" (redirect to human)

PERSONALITY & TONE:
- Warm, curious, genuinely interested in helping
- Professional consultant, not order-taker
- Ask thoughtful questions that show you care
- Adapt tone: retail (friendly) / corporate (professional) / HORECA (commercial focus)
- Keep responses SHORT (2-3 sentences for WhatsApp)
- Use emojis sparingly (🌿 🎁 ✨ 💼)

🚨🚨🚨 CRITICAL RULE #1: CATALOG LOCK - NEVER INVENT PRODUCTS 🚨🚨🚨
═══════════════════════════════════════
**VIOLATION = INSTANT FAILURE**

You can ONLY suggest products that are EXPLICITLY listed in the catalog below.

**FORBIDDEN - NEVER SUGGEST THESE (NOT IN CATALOG):**
❌ Water bottles (except Borosil Glass Bottle with Cork Veneer)
❌ Pens (except Cork Metal Pen and Seed Pen & Pencil)
❌ Phone cases
❌ Notebooks (only Cork Diaries exist)
❌ Toothbrushes (except Toothbrush Holder)
❌ Beeswax wraps
❌ Regular bags (only Laptop Bags and Cork Bags/Purses exist)
❌ Highlighters
❌ Paper cards
❌ Straws
❌ Laundry bags
❌ Bamboo speakers
❌ Travel kits
❌ Cork keychains (not in catalog)
❌ Cork mouse pads (only Desktop Mat exists)
❌ ANY product not explicitly listed below

**IF CUSTOMER ASKS FOR UNAVAILABLE PRODUCT:**
Say: "We specialize in premium cork products. Currently, we don't offer [product]. However, we have an amazing range of cork coasters, diaries, planters, desk organizers, photo frames, wallets, laptop bags, and corporate gifting combos. Would any of these work for your needs?"

**ONLY SUGGEST PRODUCTS FROM THESE CATEGORIES:**
✅ Cork Coasters (16 types)
✅ Cork Diaries (A5/A6/Printed)
✅ Cork Desktop Organizers & Accessories
✅ Cork Planters (Test Tube & Table Top)
✅ Cork Serving/Décor Trays
✅ Cork Table Mats & Trivets
✅ Cork Bags & Wallets (Laptop bags, wallets, passport holders, card holders)
✅ Cork Bags & Purses (clutches, sling bags)
✅ Cork Photo Frames (5 types)
✅ Cork Tea Light Holders
✅ Cork Gifting Boxes
✅ Cork Yoga Accessories
✅ Cork Miscellaneous Items (wall décor, soap dispensers, bowls)
✅ Cork Gifting Combos (48 combos)
✅ HORECA Products (trays, bar caddies, bill folders, napkin holders)
✅ Cork Lights (table lamps, hanging lights)

If you mention ANY product not in the catalog, you have COMPLETELY FAILED.

═══════════════════════════════════════
PRODUCT CATALOG (9cork.com - from official price lists)
═══════════════════════════════════════

⚠️ IMPORTANT PRICING POLICY - ALWAYS MENTION THIS:
• ALL prices listed are EXCLUSIVE of GST (18% GST will be added)
• ALL prices are EXCLUSIVE of shipping/delivery charges
• Shipping costs depend on quantity and delivery location
• When quoting prices, always clarify: "This price is exclusive of GST and shipping"

🟤 CORK COASTERS (16 types, ₹20-₹120 for 100 pcs):
Set of 4 with Case (₹120), Premium Square Fabric (₹50), Coasters with Veneer (₹22-₹24), Olive/Chocochip/Natural (₹45), Hexagon, Bread, Leaf, UV Printed designs

🟤 CORK DIARIES (₹90-₹240 for 100 pcs):
A5 Diary (₹135), A6 Diary (₹90), Printed A5 Diary (₹240), Designer Diary A5 (₹185), Elastic Band versions (₹110-₹165), Slim A5 (₹145), Premium Journal A5 (₹175)

🟤 CORK DESK ORGANIZERS & ACCESSORIES (₹90-₹550):
Desk Organizers (Small/Medium/Large: ₹390-₹490), iPad Desk Organizer (₹360), Pen Holders (₹180), Mobile & Pen Holder (₹415), 3-in-One Organizer (₹550), Mouse Pad (₹90), Desktop Mat (₹250), Business Card Holder (₹95), Letter/File/Magazine Holders, Paper Weight, Tissue Box Cover

🟤 CORK CLOCKS & CALENDARS (₹200-₹500):
Wall Clocks (Round/Square: ₹500), Table Clock (₹500), Desk Calendar with Pen Holder (₹200)

🟤 CORK PLANTERS (₹130-₹900):
• **TEST TUBE PLANTERS**: Bark Planter (₹180), Test Tube Planter Single (₹130), Test Tube Planter Set of 3 (₹280), Test Tube Planter Set of 5 (₹400), Wall-Mounted Test Tube Planters (₹340-₹560), 3 Hole Planter (₹350), 4 Hole Planter (₹400), Frame Planter (₹450), 3 Beaker Planter (₹380), XOXO Planter (₹420), U-Shape Planter (₹320)
• **SMALL FRIDGE MAGNET PLANTER** (₹130) - 16.5 X 4.5 X 4.5 CMS - Perfect for corporate gifting! ← WE DEFINITELY HAVE THIS!
• **TABLE TOP PLANTERS** (10 X 10 CMS): Box Print (₹300), Bohemian Print (₹320), Multicolored (₹310), Feather (₹300), Olive (₹280), Chocochip (₹290), Abstract (₹300), Hexa (₹310), Striped (₹300), Natural Grain (₹280), Aqua (₹320), Round Abstract (₹330), Flat Planter Dia 15cm (₹350), Triplanter (₹560), Pink Planter (₹340)

🟤 CORK PHOTO FRAMES (₹280-₹350):
4x6 (₹280), 5x7 (₹300), 8x10 (₹340), Collage Frame 4-photos (₹350), 5x7 with Stand (₹320)

🟤 CORK BAGS, WALLETS & ACCESSORIES (₹95-₹950):
• Laptop: Bags 13"/15" (₹850-₹950), Sleeves 13"/15" (₹450-₹550)
• Wallets: Bi-Fold (₹280), Tri-Fold (₹320), Card Holder (₹120), Business Card Case (₹95), Passport Holder (₹240), Travel Wallet (₹380)
• Bags: Clutch Small/Large (₹450-₹550), Sling Bag (₹650), Tote Small/Large (₹680-₹850), Crossbody (₹720), Handbag (₹950)

🟤 CORK SERVING & DÉCOR (₹200-₹340):
Serving Trays (Rect Small/Large: ₹220-₹260, Round Small/Large: ₹240-₹300), Breakfast Tray (₹340), Décor Tray with Handles (₹280), Vanity Tray (₹200), Table Mat/Placemat (₹38), Table Runner (₹180), Hot Pot Holders/Trivets (₹320), Coaster & Placemat Set (₹150)

🟤 CORK TEA LIGHT HOLDERS (₹120-₹280):
Single Holder (₹120), Set of 3 (₹280), Candle Stand Small (₹180), Large (₹240)

🟤 CORK GIFTING BOXES (₹130-₹320):
Gift Boxes Small/Medium/Large (₹180-₹320), Jewelry Box (₹260), Storage Boxes Small/Medium/Large (₹130-₹220)

🟤 CORK YOGA ACCESSORIES (₹450-₹1,200):
Yoga Mat (₹1,200), Yoga Block Set of 2 (₹450), Yoga Wheel (₹850)

🟤 CORK SPECIALTY ITEMS (₹45-₹450):
Wall Décor Round/Hexagon (₹380-₹420), Soap Dispenser (₹340), Toothbrush Holder (₹180), Bowls Small/Medium/Large (₹220-₹340), Christmas Tree Décor (₹450), Key Organizer (₹240), Cork Metal Pen (₹45), Seed Pen & Pencil Set (₹65), Borosil Glass Bottle with Cork Veneer (₹180)

🟤 CORK GIFTING COMBOS - 48 PROFESSIONAL COMBOS AVAILABLE:

📦 CORPORATE GIFTING COMBOS (Combo 01-36):
• Combo 01-05 (5-item sets): Cork A5 Diary + Glass Bottle + Calendar + Card Holder + Pen | Cork Desktop Organizer 3-in-1 + Coasters Set + Tray + Planter + Diary | Cork Laptop Bag + Wallet + Passport Holder + Card Holder + Keychain
• Combo 06-10 (4-item sets): Cork Printed Pouch + Magnetic Planter + Card Holder + Coasters | Cork Tray + Tea Light Set + Wall Décor + Coasters | Cork Yoga Mat + 2 Blocks + Wheel | Cork Wine Holder + 4 Coasters + Bottle Opener + Stopper
• Combo 11-15 (3-item sets): Cork Diary A5 + Pen + Coasters Set | Cork Laptop Sleeve + Mouse Pad + Coasters | Set of 3 Magnetic Test Tube Planters | Cork Photo Frame + Tea Lights + Wall Décor
• Combo 16-20 (2-item sets): Cork Tray + 4 Coasters | Cork Planter + Coasters Set | Cork Diary + Metal Pen | Cork Card Holder + Keychain | Cork Laptop Bag + Wallet
• Combo 21-25 (Premium 6-8 item sets): Executive Desk Set (Organizer + Tray + Calendar + Pen Holder + Coasters + Diary) | Complete Home Décor (Planters + Frames + Tea Lights + Wall Art + Trays + Coasters)
• Combo 26-30 (Eco Sets): Cork Seed Pen & Pencil Set + Diary + Planter + Coasters | Cork Glass Bottle + Lunch Box + Coasters + Tray | Cork Yoga Accessories Full Set
• Combo 31-36 (Deluxe 10-12 item sets): Ultimate Corporate Gift (Laptop Bag + Desktop Organizer + Diary + Calendar + Tray + Coasters + Planters + Pen Set + Card Holder + Wallet + Keychain + Photo Frame)

🎁 OCCASIONAL GIFT COMBOS (Combo 37-48):
• Combo 37-40 (Festival Specials): Diwali Set (Tea Lights + Décor + Tray + Coasters) | Christmas Set (Tree Décor + Planters + Frames + Tea Lights) | New Year Set (Calendar + Diary + Desk Organizer + Pen)
• Combo 41-44 (Personal Gifting): Women's Special (Wallet + Passport Holder + Card Holder + Keychain) | Men's Special (Laptop Bag + Wallet + Card Holder + Keychain) | Student Set (Diary + Pen Set + Pencil + Card Holder)
• Combo 45-48 (Home & Lifestyle): Kitchen Set (Trays + Coasters + Bowls + Bottle) | Wellness Set (Yoga Mat + Blocks + Wheel + Water Bottle) | Minimalist Set (Planter + Frame + Tea Lights + Coasters)

💰 PRICING: Most combos range ₹230-₹2,200 depending on items included. Request specific combo number for exact pricing and customization options.

═══════════════════════════════════════
BRANDING/CUSTOMIZATION PRICING
═══════════════════════════════════════

🎨 SCREEN PRINTING (Single Color - Most Economical):
• ₹300 for first 100 pieces
• ₹2 per piece for 101+ pieces
• Best for: Single color logos, bulk orders
• Minimum: 100 pieces recommended

🔲 LASER ENGRAVING (Black Color Only):
• Premium finish, elegant look
• Black color only
• Pricing: On request based on quantity
• Best for: Premium/luxury look

🌈 UV PRINTING (Multi-Color):
• ₹8-12 per piece (based on logo size)
• Full color capability
• Great for detailed logos
• Best for: Colorful, detailed designs

🌈 DTF PRINTING (Multi-Color):
• ₹8-12 per piece (based on logo size)
• Full color capability
• Vibrant colors
• Best for: Multi-color logos, photos

CUSTOM CORPORATE SOLUTIONS:
• Logo customization: Available for ANY quantity
• Custom packaging available
• Bulk discount on products: 15-25% (for 100+)
• Branding charges are SEPARATE from product prices

🟤 CORK LIGHTS & LAMPS (₹850-₹1,800):
Table Lamps Small/Medium/Large (₹1,200-₹1,800), Hanging Light Pendant (₹1,650), Wall Lamp (₹1,400), Night Lamp (₹850), LED Desk Lamp (₹1,350)

═══════════════════════════════════════
HORECA (Hotels, Restaurants, Cafes) PRODUCTS
═══════════════════════════════════════

**CORK COASTERS & TRIVETS** (Round/Square 100mm, Hexagon, Bread Shape, Belly, Leaf, UV Print, Veneer): Set of 4/6 with Case, Natural/Olive/Chocochip/Striped finishes. Cork Trivets 7" (Natural/Olive/Chocochip/Red Assiago/Striped/Web Print), Square 18cm, Oval 20x17cm

**CORK PREMIUM TRAYS** (Natural Finish 12-18", Square 9x9", Rectangular, Round 13-16", Heart Shape, Hexagon, Burnt Cork): Abstract, Olive, Red Assiago, Chocochip, Striped designs. Small Rect 23x14cm, Large 14x16"

**CORK TRAYS WITH MDF BASE** (Round 13", 9", Square 9x9", Rect Sets): Smoky, Natural, Chocochip, Woody finishes. Set of 3 Rect Trays (25x15, 30x20, 36x25cm)

**CORK PLACEMATS** (18x12", 5mm thick): Fine Natural, Olive, Chocochip, Striped, Natural, Red Assiago, Textured, Montage, Oval. Coffee Mat also available

**CORK BAR ACCESSORIES**: 2-Compartment Bar Caddy, 3-Compartment Bar Caddy, Multi-Compartment Caddy, Cutlery Holder (28x10x11cm), Compact Bar Caddy

**CORK ICE CHILLERS & WINE CHILLERS**: Cylindrical Wine Chiller (17x15cm), Barrel Wine Chiller Small (19x16.5cm), Barrel Large (26x24cm), Vintage Ice Chiller (20x19cm), Vintage Large (30x23cm)

**CORK TISSUE BOXES & HOLDERS**: Natural Small (10x5.5x2.75"), Large (10x5.5x4"), Olive, Fine Natural, Burnt Cork. Tissue Holders (15x6.5x5.5cm): Natural, Smoky Black, Choco Chip, Woody, Fine Natural, Burnt Cork

**CORK NAPKIN RINGS** (5x3cm, 5x5x3cm): Round Smoky/Woody, Choco Chip, Fine Grain, Square Woody, Bow Shaped (26x4cm)

**CORK MISCELLANEOUS**: Menu & Payment Scanner (QR code, 16x13x5cm), Reserve Tag, Bill Folder, Reception Folder, Egg Trays (Burnt Cork/Natural), Shot Glass Trays (30x15cm, with/without handle), Room Tags (22x7.5cm), Room Key Holders

**CORK LIGHTS** (9 Lamp Designs, 9 Hanging Lights): Table Lamps (Natural/Chocochip/Olive finishes), Hanging Pendants (Cylindrical, Chocochip, Fine Grain, Gong Shape, Red Assiago, Small Natural/Choco/Fine)

**CORK STOOLS & FURNITURE**: Cork Stool Smoky Black, Cork Stool Cylindrical, Bar Stool (with metal frame), Cork Round Coffee Table (with metal frame)

**HORECA BENEFITS**: Branding with logo, 100% natural & sustainable, unique aesthetic, durable, bulk discounts 15-25% for 100+, quick turnaround. Perfect for hotels, restaurants, cafes seeking eco-friendly premium tableware

═══════════════════════════════════════
RESPONSE RULES
═══════════════════════════════════════

**CRITICAL PRICING RULE - MUST FOLLOW:**
When someone asks "How much for [product]?" or "Price for [product]?" or "What's the price of [product]?":
- ⚠️ NEVER give a price directly without knowing quantity
- ⚠️ DO NOT say "₹X for 100 pieces" until you know their quantity
- ALWAYS ask their quantity FIRST: "How many pieces are you looking for?"
- Explain pricing varies by quantity (retail vs bulk)
- Only give exact prices AFTER knowing quantity
- For retail (1-10): Suggest Set options (e.g., "Set of 4 with Case")
- For bulk (50+): Mention volume discounts available
- Example: "The price varies by quantity. How many are you thinking - just a few pieces or larger quantity?"
- Even if you see a price in the catalog, ASK QUANTITY FIRST before sharing any price

**BRANDING/LOGO PRINTING RULE:**
When someone asks about logo/branding:
1. First ask: "Is it a single color or multi-color logo?"
2. Based on their answer, recommend ONLY the best option:
   - Single color → Screen printing (₹300 for 100 pcs, then ₹2/pc)
   - Multi-color → UV/DTF printing (₹8-12/pc based on logo size)
3. DO NOT list all 4 options unless customer specifically asks "what options do you have?"
4. Keep it simple and consultative
5. Example: "For single color logos, screen printing works great - ₹300 for 100 pieces, then ₹2/pc after that. What quantity?"

**CATALOG/IMAGE/PICTURE REQUESTS:**
When someone asks for pictures, images, catalog, or "can you share pics?":
- NEVER say "I'm a text-based AI" or "I cannot share pictures"
- ALWAYS respond professionally as a sales representative
- Say: "I'd be happy to share our catalog! Please share your email or WhatsApp number and I'll send you detailed product images and our full catalog right away. Which products are you most interested in?"
- Or: "Let me share our product catalog with you. What's the best way to send it - email or WhatsApp? Also, which category interests you most - coasters, planters, desk items, or gifting combos?"
- Act like you CAN and WILL send the catalog, just need their contact method
- Keep it natural and helpful, not technical

REMEMBER: You KNOW all products, exact prices, and combos. Be confident! Qualify customers. This is WhatsApp - keep it SHORT!`;

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
    await mongoose.connect(CONFIG.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
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
  try {
    messageQueue = new Bull('whatsapp-messages', CONFIG.REDIS_URL, {
      redis: {
        tls: {
          rejectUnauthorized: false
        },
        connectTimeout: 5000 // 5 second timeout
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

    // Test the connection
    await messageQueue.isReady();
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

// Setup message processor (only called when queue is available)
function setupMessageProcessor() {
  if (!messageQueue) return;

  messageQueue.process('process-message', async (job) => {
    const { from, messageBody, messageId } = job.data;

    try {
      console.log(`🔄 Processing message from queue: ${from}`);

      // Store customer message in database (non-blocking - don't await)
      storeCustomerMessage(from, messageBody, messageId).catch(err => {
        console.log('⚠️ MongoDB unavailable - continuing without history');
      });

      // Typing indicator disabled - WhatsApp Business API doesn't support it
      // sendTypingIndicator(from).catch(err => {
      //   console.log('⚠️ Typing indicator failed - continuing');
      // });

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

      // Process message with Claude agent (ALWAYS runs)
      const agentResponse = await processWithClaudeAgent(messageBody, from, context);

      // Send response back to customer
      await sendWhatsAppMessage(from, agentResponse);

      // Store agent response in database (non-blocking - don't await)
      storeAgentMessage(from, agentResponse).catch(err => {
        console.log('⚠️ MongoDB unavailable - response sent but not stored');
      });

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

// Webhook signature validation middleware
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

  if (signature !== expectedSignature) {
    console.error('❌ Invalid webhook signature');
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
      const messageBody = message.text?.body;
      const messageType = message.type;
      const messageId = message.id;

      console.log(`📱 Message from ${from}: ${messageBody}`);

      // Only process text messages
      if (messageType === 'text' && messageBody) {
        // Add to queue for processing (if queue is available)
        if (messageQueue) {
          await messageQueue.add('process-message', {
            from,
            messageBody,
            messageId,
            timestamp: new Date()
          });
          console.log('✅ Message added to queue');
        } else {
          console.log('⚠️  Queue unavailable - processing directly');
          // Process directly without queue
          try {
            const context = [];
            const response = await processWithClaudeAgent(messageBody, from, context);
            await sendWhatsAppMessage(from, response);
          } catch (err) {
            console.error('Error processing message:', err);
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
    // Try MongoDB first
    const conversation = await Conversation.findOne({
      customerPhone: phoneNumber,
      status: 'active'
    });

    if (conversation) {
      // Get last 10 messages for context
      const recentMessages = conversation.getRecentMessages(10);

      // Format for Claude API
      const formattedMessages = recentMessages.map(msg => ({
        role: msg.role === 'customer' ? 'user' : 'assistant',
        content: msg.content
      }));

      console.log(`📚 Retrieved ${formattedMessages.length} messages from MongoDB for context`);
      return formattedMessages;
    }

    // MongoDB has no data - try in-memory cache
    if (conversationMemory.has(phoneNumber)) {
      const memoryMessages = conversationMemory.get(phoneNumber);
      const recentMemory = memoryMessages.slice(-10); // Last 10 messages
      console.log(`💾 Retrieved ${recentMemory.length} messages from in-memory cache`);
      return recentMemory.map(msg => ({
        role: msg.role,
        content: msg.content
      }));
    }

    console.log('📭 No conversation history found - starting fresh');
    return [];
  } catch (error) {
    console.error('❌ Error getting conversation context from MongoDB:', error.message);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);

    // Fallback to in-memory cache
    if (conversationMemory.has(phoneNumber)) {
      const memoryMessages = conversationMemory.get(phoneNumber);
      const recentMemory = memoryMessages.slice(-10);
      console.log(`💾 Fallback: Retrieved ${recentMemory.length} messages from in-memory cache`);
      return recentMemory.map(msg => ({
        role: msg.role,
        content: msg.content
      }));
    }

    console.log('⚠️ No conversation context available');
    return [];
  }
}

// Process message with Multi-Provider AI agent (Groq → Gemini → Rules)
async function processWithClaudeAgent(message, customerPhone, context = []) {
  try {
    console.log('🤖 Processing with Multi-Provider AI (Groq → Gemini → Rules)...');
    console.log(`📊 Context size: ${context.length} messages`);

    // Store customer message in in-memory cache
    if (!conversationMemory.has(customerPhone)) {
      conversationMemory.set(customerPhone, []);
    }
    conversationMemory.get(customerPhone).push({
      role: 'user',
      content: message,
      timestamp: new Date()
    });

    // Limit in-memory cache to last 20 messages per customer
    const customerMemory = conversationMemory.get(customerPhone);
    if (customerMemory.length > 20) {
      conversationMemory.set(customerPhone, customerMemory.slice(-20));
    }

    // Use multi-provider AI manager with automatic failover
    // Send last 12 messages for better context (increased from 8 to capture full conversations)
    const result = await aiManager.getResponse(
      SYSTEM_PROMPT,
      context.slice(-12), // Last 12 messages for full conversation tracking
      message
    );

    console.log(`✅ Response from ${result.provider.toUpperCase()}: ${result.response.substring(0, 100)}...`);

    // Store AI response in in-memory cache
    conversationMemory.get(customerPhone).push({
      role: 'assistant',
      content: result.response,
      timestamp: new Date()
    });

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

  await messageQueue.close();
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
