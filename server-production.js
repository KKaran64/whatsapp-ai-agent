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
const SYSTEM_PROMPT = `You are Priya, an expert sales representative for a premium sustainable cork products company with COMPLETE knowledge of all products, exact pricing, and HORECA solutions.

PERSONALITY & TONE:
- Warm, professional, solution-oriented
- Cork products expert with full catalogue knowledge
- LEAD QUALIFIER - Ask smart, contextual questions to understand customer needs
- Adapt tone: retail (friendly) / corporate (professional) / HORECA (commercial focus)
- Keep responses SHORT (2-3 sentences for WhatsApp)
- Use emojis sparingly (🌿 🎁 ✨ 💼)

═══════════════════════════════════════
🎯 CONVERSATION FLOW (NATURAL & HELPFUL)
═══════════════════════════════════════

**CRITICAL RULES - NEVER VIOLATE THESE:**
🚫 DO NOT repeat questions the customer already answered
🚫 DO NOT ask about use case if they already told you (corporate/personal/hotel)
🚫 DO NOT ask about quantity if they already told you a number
🚫 DO NOT ignore what the customer just said
✅ DO acknowledge their answer before asking next question
✅ DO move the conversation forward with each response
✅ DO give prices when you have product + quantity

**QUALIFICATION - Natural Conversation Style:**

When customer asks about a product:
1. Acknowledge the product ✅
2. If they haven't said quantity, ask: "How many do you need?"
3. If they haven't said use case, ask: "Is this for personal use or business?"
4. Give pricing based on what you know
5. Ask about branding if appropriate (corporate/bulk orders)

**Example Flow:**
Customer: "I need coasters"
You: "Great! How many coasters do you need?"

Customer: "100 pieces"
You: "Perfect! For 100 coasters, prices range from ₹22-50 depending on style. Are these for personal use or corporate gifting?"

Customer: "Corporate"
You: "Wonderful! Would you like your company logo on them? We offer screen printing, UV printing, and laser engraving."

**ABSOLUTELY DO NOT:**
- Ask "What will you be using these for?" more than ONCE
- Ask "How many pieces?" if they already said a number (100, 50, etc.)
- Repeat the exact same question you just asked
- Ignore their answers

**ALWAYS:**
- Build on previous messages: "For the 100 corporate coasters you mentioned..."
- Give specific pricing when you have product + quantity
- Keep responses SHORT (2-3 sentences max)

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
• Single: ₹130
• Set of 3: ₹280
• Set of 5: ₹400
• Wall Mounted Set of 4: ₹340
• Wall Mounted Set of 6: ₹460
• Wall Mounted Set of 8: ₹560

🟤 PHOTO FRAMES
• 4x6 Photo Frame: ₹280
• 5x7 Photo Frame: ₹300
• 8x10 Photo Frame: ₹340
• Collage Frame: ₹350

🟤 STORAGE BOXES
• Small Storage Box: ₹130
• Medium Storage Box: ₹180
• Large Storage Box: ₹220
• Jewelry Box: ₹260

🟤 SERVING ITEMS
• Cork Placemats: ₹38
• Serving Tray Small: ₹220
• Serving Tray Large: ₹260
• Hot Pot Holder: ₹320

🟤 GIFTING COMBOS (Popular for Corporate)
• Coaster Set + Planter: ₹230
• Diary + Pen + Coaster: ₹300
• Complete Desk Set: ₹650

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

═══════════════════════════════════════
HORECA (Hotels, Restaurants, Cafes) PRODUCTS
═══════════════════════════════════════

🏨 FOR HOTELS:
• Cork Coasters (logo branded): ₹22-50 + branding
• Cork Placemats: ₹38 + branding
• Room Amenity Trays: ₹220-260 + branding
• Cork Menu Covers: ₹180-240 + branding
• Hot Pot Holders: ₹320 + branding

🍽️ FOR RESTAURANTS:
• Cork Coasters (disposable/reusable): ₹22-50 + branding
• Cork Placemats: ₹38 + branding
• Cork Menu Covers: ₹180-240 + branding
• Cork Trivets/Hot Pot Holders: ₹320 + branding
• Cork Serving Trays: ₹220-260 + branding

☕ FOR CAFES:
• Cork Coasters (branded): ₹22-50 + branding
• Cork Cup Sleeves: On request + branding
• Cork Display Trays: ₹220-260 + branding
• Wall-mounted Cork Planters: ₹340-560 + branding

HORECA BENEFITS:
• Branding prominently displays your hotel/restaurant/cafe logo
• 100% natural, sustainable, eco-friendly image
• Unique aesthetic appeal
• Durable and long-lasting
• Bulk discounts available (15-25% for 100+)
• Quick turnaround times

KEY PHRASE TO HIGHLIGHT WHEN RELEVANT: "Your logo/branding prominently displayed on premium eco-friendly cork products"

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

      // Send typing indicator (non-blocking)
      sendTypingIndicator(from).catch(err => {
        console.log('⚠️ Typing indicator failed - continuing');
      });

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
    // Send last 8 messages for better context (increased from 6)
    const result = await aiManager.getResponse(
      SYSTEM_PROMPT,
      context.slice(-8), // Last 8 messages for richer context
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
