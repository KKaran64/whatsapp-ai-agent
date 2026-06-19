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

// Import Token-Optimized Bot (3-agent architecture: Router + State + Responder)
// Reduces token usage from 800-2000 to ~255 tokens per message
const { getInstance: getOptimizedBot } = require('./optimized-bot');

// Import Product Image Database (STRICT: Cork products only)
// V2 JSON system is the fallback when MongoDB product search fails
const { findProductImage, getCatalogImages, isValidCorkProductUrl, getDatabaseStats } = require('./product-images-v2');

// Import System Prompt Builder (extracted for maintainability)
const { buildSystemPrompt } = require('./prompts/system-prompt');

// RAG modules — retrieval & async indexing of conversations
const { retrieveContext } = require('./rag/retriever');
const { buildRagContext } = require('./rag/context-builder');
const { indexQAPair } = require('./rag/indexer');

// Redis-backed sent images tracker (survives deploys; falls back to in-memory when Redis unavailable)
const { RedisSentImagesTracker } = require('./utils/redis-state');

// Track sent images per conversation to avoid duplicates
let sentImagesTracker = new RedisSentImagesTracker(null); // will be upgraded to Redis after connectQueue

// Per-phone processing queue (serialize messages from same customer to prevent race conditions)
const phoneProcessingLock = new Map(); // phone -> Promise

// MongoDB Product Query Helpers
async function findProductsByCategory(category, limit = 10, phoneNumber = null, excludeSent = false) {
  try {
    // v53.17 UNIVERSAL SEARCH: Search by name/tags/aliases FIRST, then category as fallback
    // This works for ALL products - no special cases needed!

    // Map simplified category names to database categories (used as fallback only)
    const categoryMap = {
      'coasters': 'COASTER',
      'diaries': 'DIAR',  // Matches both "DIARIES" and "C0RK DIARIES"
      'desk': 'DESK',
      'bags': 'BAG',
      'planters': 'PLANTER',
      'trays': 'TRAY',  // Matches "CORK SERVING/DECOR TRAYS"
      'bottles': 'BOTTLE',
      'frames': 'FRAME',  // Matches "CORK LINEA PHOTO FRAME"
      'calendar': 'CALEND',  // Search for "CALEND" in name, not category
      'mousepad': 'MOUSE',  // Added for mousepads
      'candles': 'CANDLE',  // Added for candles and tea lights
      'all': ''
    };

    const searchTerm = category === 'all' ? '' : category;
    const categoryFallback = categoryMap[category] || category;

    console.log(`🔍 MongoDB UNIVERSAL search for: "${searchTerm}"`);

    // UNIVERSAL MULTI-FIELD SEARCH (works for ALL products!)
    let products = [];

    if (category === 'all') {
      // Get variety of products from all categories
      products = await Product.find({}).limit(limit * 2);
    } else {
      // Search by: name → tags → aliases → category (in priority order)
      products = await Product.find({
        $or: [
          { name: new RegExp(searchTerm, 'i') },           // FIRST: Product name (e.g., "CALENDER")
          { tags: new RegExp(searchTerm, 'i') },           // SECOND: Tags (e.g., "calendar")
          { aliases: new RegExp(searchTerm, 'i') },        // THIRD: Aliases (e.g., "notebook" for diaries)
          { category: new RegExp(categoryFallback, 'i') }  // FOURTH: Category fallback
        ]
      }).limit(limit * 2);
    }

    console.log(`   → Found ${products.length} products before filtering`);
    if (products.length > 0) {
      console.log(`   → Sample: ${products[0].name} (${products[0].category})`);
    }

    // Filter out already-sent images if requested
    if (excludeSent && phoneNumber) {
      const sentUrls = new Set(await sentImagesTracker.getAll(phoneNumber));
      products = products.filter(p => {
        if (!p.images || p.images.length === 0) return false;
        return !sentUrls.has(p.images[0]);
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

// Trust Render.com's single-hop proxy. Render strips X-Forwarded-For from clients
// before adding its own, so trusting one hop is safe here. This ensures req.ip is
// correctly set for rate limiting across Render's private IP infrastructure.
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
  ADMIN_SECRET: (process.env.ADMIN_SECRET || '').trim(),
  WHATSAPP_APP_SECRET: (process.env.WHATSAPP_APP_SECRET || '').trim(),
  PORT: process.env.PORT || 3000,
  // Groq API keys (up to 4)
  GROQ_API_KEY: (process.env.GROQ_API_KEY || 'your_groq_api_key').trim(),
  GROQ_API_KEY_2: (process.env.GROQ_API_KEY_2 || '').trim(),
  GROQ_API_KEY_3: (process.env.GROQ_API_KEY_3 || '').trim(),
  GROQ_API_KEY_4: (process.env.GROQ_API_KEY_4 || '').trim(),
  // Gemini API keys (up to 20)
  GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
  GEMINI_API_KEY_2: (process.env.GEMINI_API_KEY_2 || '').trim(),
  GEMINI_API_KEY_3: (process.env.GEMINI_API_KEY_3 || '').trim(),
  GEMINI_API_KEY_4: (process.env.GEMINI_API_KEY_4 || '').trim(),
  GEMINI_API_KEY_5: (process.env.GEMINI_API_KEY_5 || '').trim(),
  GEMINI_API_KEY_6: (process.env.GEMINI_API_KEY_6 || '').trim(),
  GEMINI_API_KEY_7: (process.env.GEMINI_API_KEY_7 || '').trim(),
  GEMINI_API_KEY_8: (process.env.GEMINI_API_KEY_8 || '').trim(),
  GEMINI_API_KEY_9: (process.env.GEMINI_API_KEY_9 || '').trim(),
  GEMINI_API_KEY_10: (process.env.GEMINI_API_KEY_10 || '').trim(),
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
  NODE_ENV: process.env.NODE_ENV || 'development',
  // Contact info (used in fallback responses — change in .env, not here)
  CONTACT_PHONE: (process.env.CONTACT_PHONE || '+91 70090 52784').trim(),
  CONTACT_EMAIL: (process.env.CONTACT_EMAIL || 'info@9cork.com').trim(),
  CONTACT_WEBSITE: (process.env.CONTACT_WEBSITE || 'www.9cork.com').trim(),
  // RAG configuration
  PINECONE_API_KEY: (process.env.PINECONE_API_KEY || '').trim(),
  PINECONE_INDEX: (process.env.PINECONE_INDEX || 'ninecork-conversations').trim(),
  RAG_ENABLED: process.env.RAG_ENABLED === 'true',
  RAG_RETRIEVAL_TIMEOUT_MS: parseInt(process.env.RAG_RETRIEVAL_TIMEOUT_MS || '2000'),
  ADMIN_WHATSAPP_NUMBER: (process.env.ADMIN_WHATSAPP_NUMBER || '').trim(),
  WEEKLY_REPORT_ENABLED: process.env.WEEKLY_REPORT_ENABLED === 'true'
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
  GROQ_API_KEY_2: CONFIG.GROQ_API_KEY_2,
  GROQ_API_KEY_3: CONFIG.GROQ_API_KEY_3,
  GROQ_API_KEY_4: CONFIG.GROQ_API_KEY_4,
  GEMINI_API_KEY: CONFIG.GEMINI_API_KEY,
  GEMINI_API_KEY_2: CONFIG.GEMINI_API_KEY_2,
  GEMINI_API_KEY_3: CONFIG.GEMINI_API_KEY_3,
  GEMINI_API_KEY_4: CONFIG.GEMINI_API_KEY_4,
  GEMINI_API_KEY_5: CONFIG.GEMINI_API_KEY_5,
  GEMINI_API_KEY_6: CONFIG.GEMINI_API_KEY_6,
  GEMINI_API_KEY_7: CONFIG.GEMINI_API_KEY_7,
  GEMINI_API_KEY_8: CONFIG.GEMINI_API_KEY_8,
  GEMINI_API_KEY_9: CONFIG.GEMINI_API_KEY_9,
  GEMINI_API_KEY_10: CONFIG.GEMINI_API_KEY_10,
  ANTHROPIC_API_KEY: null // Disabled - using only free providers
});

console.log(`✅ AI Manager initialized with ${aiManager.groqClients ? aiManager.groqClients.length : 0} Groq keys`);

// Initialize Vision Handler (v53.42: Smart 3-Layer Matching with 8+ Vision APIs)
// Layer 1: Hash matching (instant, exact products)
// Layer 2: Visual analysis (color, shape, CLIP-like)
// Layer 3: Multiple Vision APIs (Clarifai, Imagga, DeepAI, SambaNova, Cloudflare, etc.)
const visionHandler = new VisionHandler({
  WHATSAPP_TOKEN: CONFIG.WHATSAPP_TOKEN,

  // v53.42: TIER 1 - Dedicated Image Recognition APIs (most reliable)
  CLARIFAI_API_KEY: process.env.CLARIFAI_API_KEY,            // 5k free/month
  IMAGGA_API_KEY: process.env.IMAGGA_API_KEY,                // 1k free/month
  IMAGGA_API_SECRET: process.env.IMAGGA_API_SECRET,
  DEEPAI_API_KEY: process.env.DEEPAI_API_KEY,                // Free tier

  // v53.42: TIER 2 - LLM Vision APIs
  SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY,          // Free, very fast
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,  // Free 10k/day
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,          // Free tier
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,        // Free models
  HYPERBOLIC_API_KEY: process.env.HYPERBOLIC_API_KEY,        // Free tier
  TOGETHER_API_KEY: process.env.TOGETHER_API_KEY,            // Free Llama-Vision

  // Fallback providers
  GEMINI_API_KEY: CONFIG.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: CONFIG.ANTHROPIC_API_KEY,
  GOOGLE_CLOUD_VISION_KEY: CONFIG.GOOGLE_CLOUD_VISION_KEY,
  HUGGINGFACE_TOKEN: CONFIG.HUGGINGFACE_TOKEN
});

// Keep a reference to the basic system prompt for cases where we don't have metadata
const SYSTEM_PROMPT = buildSystemPrompt();

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
      socketTimeoutMS: 10000,        // Close sockets after 10s (webhook must respond in ~5s)
      family: 4                      // Use IPv4, avoid IPv6 issues
    });
    console.log('✅ MongoDB connected with connection pooling (2-10 connections)');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Continuing without MongoDB - conversation history disabled');
    if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
  }
}

// FIX #3: MongoDB Reconnection Logic (auto-recovery from disconnects with exponential backoff)
// Exported for testing
function calculateReconnectDelay(attempt) {
  const base = 5000;
  const max = 60000;
  return Math.min(base * Math.pow(2, attempt), max);
}

let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

mongoose.connection.on('disconnected', () => {
  console.error('❌ MongoDB disconnected.');
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Max reconnect attempts reached. Manual intervention required.');
    return;
  }

  const delay = calculateReconnectDelay(reconnectAttempt);
  reconnectAttempt++;
  console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);

  setTimeout(() => {
    mongoose.connect(CONFIG.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    }).then(() => {
      console.log('✅ MongoDB reconnected successfully');
      reconnectAttempt = 0;
    }).catch(err => {
      console.error('❌ MongoDB reconnection failed:', err.message);
      if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
    });
  }, delay);
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err.message);
  if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
  reconnectAttempt = 0;
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

    // Upgrade sentImagesTracker to Redis-backed store
    const IORedis = require('ioredis');
    const stateRedis = new IORedis(CONFIG.REDIS_URL, {
      tls: CONFIG.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableReadyCheck: false
    });
    stateRedis.on('error', (err) => {
      console.warn('⚠️ State Redis error (sentImagesTracker degraded to in-memory):', err.message);
    });
    sentImagesTracker = new RedisSentImagesTracker(stateRedis);
    console.log('✅ Redis-backed sentImagesTracker initialized');

    // Set up message processor
    setupMessageProcessor();
  } catch (err) {
    console.error('❌ Redis connection error:', err.message);
    console.log('⚠️  Continuing without queue - messages will be processed directly');
    messageQueue = null;
    // When Redis unavailable, sentImagesTracker stays as in-memory fallback (already initialized above)
    console.log('ℹ️ sentImagesTracker using in-memory fallback (Redis unavailable)');
    if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
  }
}

// SHARED: Image detection and sending logic (used by BOTH queue and direct paths)
async function handleImageDetectionAndSending(from, agentResponse, messageBody, conversationContext = []) {
  try {
    // Pattern constants (defined once, used multiple times)
    // STRICT: Only words that explicitly REQUEST images, not conversational words like "have"
    // CRITICAL FIX v53: Exclude "photo frames" and "picture frames" (product names, not photo requests)
    // v53.32 FIX: Exclude "check the image", "see the image" - these are NOT requests to send images
    const TRIGGER_WORDS = /\b(show|send|share|reshare|resend|re-share|re-send)\b.*\b(picture|pictures|photo|photos|image|images)\b|\b(picture|pictures|photo|photos|image|images)\b.*\b(show|send|share|reshare|resend|re-share|re-send)\b/i;
    // v54.3: Option-sharing patterns - catches "share options", "show all", "send varieties"
    const OPTION_TRIGGERS = /\b(share|show|send|reshare|resend)\b.*\b(options?|varieties?|range|collection|types?|all)\b/i;
    // v54.3: Resend detection - clears sent tracker when customer didn't receive images
    const RESEND_PATTERN = /\b(reshare|resend|again|re-share|re-send|pls share|please share|didn'?t get|not received|haven'?t received)\b/i;
    // AUTO-GENERATED from product-image-database.json v1.3 - includes ALL product keywords from 9cork.com AND homedecorzstore.com - 41 products, 123 keywords
    const PRODUCT_KEYWORDS = /(13inch|15inch|3in1|3inone|4pcs|accessory|and|aqua|bag|bifold|bohemian|box|breakfast|bridge|business|calendar|candle|card|case|catchall|chip|choco|chocochip|clutch|coaster|coasters|combo|cube|cubic|designer|desk|desktop|diamond|diaries|diary|dining|fabric|flat|for|frame|frames|fridge|grain|hanging|heart|holder|hot|inch|journal|keychain|ladies|laptop|large|leaf|light|lights|magnet|mat|men|minimalistic|mouse|mousepad|multicolor|multicolored|natural|notebook|office|organizer|pad|passport|pattern|patterned|pen|pencil|piece|placemat|placemats|plain|planner|plant|planter|planters|plants|pot|premium|print|round|rubberized|runner|serving|set|shaped|sleeve|small|square|stand|stationery|striped|succulent|table|tablemat|tablemats|tabletop|tea|tealight|test|testtube|texture|textured|top|tote|travel|tray|trinket|triple|trivet|trivets|tube|ushaped|wall|wallet|with|women|workspace)/i;

    // CRITICAL FIX: Only use USER message for detection, NEVER bot response
    // This prevents bot saying "Let me show you diaries" from triggering images
    let userMessage = messageBody || '';
    const hasTrigger = TRIGGER_WORDS.test(userMessage) || OPTION_TRIGGERS.test(userMessage);
    const isResendRequest = RESEND_PATTERN.test(userMessage);
    // v35: Catalog/PDF request detection - these bypass image trigger check
    const isCatalogRequest = /\b(catalog|catalogue|pdf|brochure|price list)\b/i.test(userMessage);

    // v54.3: Clear sent tracker when customer requests resend/reshare
    if (isResendRequest) {
      await sentImagesTracker.clear(from);
      console.log('🔄 Customer requested resend - cleared image tracker');
    }

    // v53.28 HARD STOP: NEVER send images without trigger words - NO EXCEPTIONS!
    // This prevents ALL unsolicited image sending regardless of code paths
    // Resend requests with image/product keywords also count as triggers
    // v35: Catalog/PDF requests bypass this check (handled separately below)
    if (!hasTrigger && !isCatalogRequest && !(isResendRequest && /\b(picture|pictures|photo|photos|image|images|options?)\b/i.test(userMessage))) {
      console.log('🛑 v53.28 HARD STOP: No trigger words detected, skipping ALL image sending');
      console.log(`   User message: "${userMessage.substring(0, 100)}..."`);
      console.log(`   Trigger words required: show, send, share, pictures, images, photo, options, catalog, pdf`);
      return; // EXIT IMMEDIATELY - no images will be sent
    }

    console.log('✅ Trigger words detected, proceeding with image detection...');

    // v53.4 FIX: Enhanced context-aware image detection
    // When user says generic image request OR pronouns, look at conversation history
    const pronounReferences = /\b(the same|them|it|those|these|that|above|earlier|mentioned|suggestions?)\b/i;
    // v53.7 FIX: Added typo variants (calender, organiser, etc.) to prevent wrong context matching
    const genericImageRequest = hasTrigger && !/\b(coasters?|diar(y|ies)|bags?|wallets?|planters?|desk|organiz(er|ers)|organis(er|ers)|frames?|calend[ae]rs?|pens?|notebooks?|mats?|tables?|candles?|holders?|bottles?|trays?|test.?tubes?|mousepads?)\b/i.test(userMessage);

    // v53.24 FIX: Detect generic image requests like "please share image", "share image options"
    // CRITICAL: Only extract products from USER messages, not bot responses!
    if ((pronounReferences.test(userMessage) && hasTrigger) || genericImageRequest) {
      console.log('🔍 Generic image request or pronoun detected, checking conversation context...');
      // Look at last 10 messages to find product mentions (increased from 5)
      const recentMessages = conversationContext.slice(-10);
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        const msg = recentMessages[i];
        const content = msg.content || '';
        const role = msg.role || '';

        // v53.24 CRITICAL FIX: Skip bot messages - only extract from user messages!
        if (role === 'assistant') {
          continue; // Skip bot's own messages
        }

        // Extract product keywords from recent USER conversation only (expanded list)
        const productMatch = content.match(/\b(coaster|diary|bag|wallet|planter|desk|organizer|frame|calendar|pen|notebook|mat|table|candle|tea light|tealight|holder|test tube|testtube|bottle|tray|mousepad|mouse pad)\b/i);
        if (productMatch) {
          const productContext = productMatch[0];
          console.log(`✅ Found product context from USER message: "${productContext}"`);
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

    // v53.23 FIX: Combo catalog detection - ONLY when EXPLICITLY requested!
    // Customer must explicitly ask for "catalog" or "brochure" or "PDF" combined with combo/gift keywords
    // Examples that SHOULD trigger: "send combo catalog", "show gifting brochure", "combo PDF"
    // Examples that should NOT trigger: "I need combos", "for client gifting", "gift boxes"
    const explicitCatalogRequest = /\b(catalog|catalogue|brochure|pdf|price list|pricelist)\b/i;
    const comboMention = /\b(combo|combos|gift|gifting|corporate gift)\b/i;

    // Only send combo catalog if customer explicitly requests catalog AND mentions combos/gifts
    const isExplicitComboCatalogRequest = explicitCatalogRequest.test(userMessage) && comboMention.test(userMessage);

    if (isExplicitComboCatalogRequest && CONFIG.PDF_CATALOG_COMBOS) {
      try {
        console.log('📦 Explicit combo catalog request detected, sending combos catalog to', from);
        await sendWhatsAppDocument(from, CONFIG.PDF_CATALOG_COMBOS, '9Cork-Gifting-Combos-Catalog.pdf',
          'Here is our Gifting Combos catalog with 48 combos (₹230-₹2,200)! Perfect for corporate gifting 🌿');
        return; // Exit after sending combo catalog
      } catch (error) {
        console.error('❌ Failed to send combos catalog:', error.message);
        // Continue to AI response if PDF fails
      }
    }

    // PDF Catalog detection - For general catalog requests
    // Smart routing based on keywords: HORECA or GENERAL PRODUCTS
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

    // v53.24 NEW: Detect combo-specific image requests (e.g., "share images of combo 4")
    // When customer references a specific combo/option number, extract products from bot's previous message
    const comboNumberPattern = /\b(?:combo|option|choice)\s*(?:#|no\.?|number)?\s*(\d+)\b/i;
    const comboMatch = userMessage.match(comboNumberPattern);
    let comboProducts = [];

    if (comboMatch && hasTrigger) {
      const comboNumber = parseInt(comboMatch[1]);
      console.log(`🎯 Combo-specific image request detected: Combo/Option #${comboNumber}`);

      // Look for bot's previous message containing combo suggestions
      const recentMessages = conversationContext.slice(-10);
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        const msg = recentMessages[i];
        if (msg.role === 'assistant') {
          const content = msg.content || '';
          // Find the specific combo line (e.g., "4. 1 Photo Frame + 1 Small Planter + 1 Coaster Set")
          const comboLinePattern = new RegExp(`${comboNumber}\\.?\\s*(.+?)(?:\\:|₹|\\n|$)`, 'i');
          const comboLineMatch = content.match(comboLinePattern);

          if (comboLineMatch) {
            const comboLine = comboLineMatch[1];
            console.log(`   Found combo ${comboNumber}: "${comboLine}"`);

            // Extract product keywords from this combo
            if (/photo frame|frame/i.test(comboLine)) comboProducts.push('frames');
            if (/planter/i.test(comboLine)) comboProducts.push('planters');
            if (/coaster/i.test(comboLine)) comboProducts.push('coasters');
            if (/calendar|calender/i.test(comboLine)) comboProducts.push('calendar');
            if (/diary|diaries/i.test(comboLine)) comboProducts.push('diaries');
            if (/organizer|organiser/i.test(comboLine)) comboProducts.push('desk');
            if (/bag|wallet/i.test(comboLine)) comboProducts.push('bags');
            if (/tray/i.test(comboLine)) comboProducts.push('trays');

            if (comboProducts.length > 0) {
              console.log(`   Products in combo ${comboNumber}: ${comboProducts.join(', ')}`);
              // Will send images for each product category below
              break;
            }
          }
        }
      }
    }

    // v53.24: If combo products detected, send images for all products in the combo
    if (comboProducts.length > 0) {
      console.log(`📦 Sending images for ${comboProducts.length} products in combo...`);

      // Clear sent tracker to allow re-sending
      await sentImagesTracker.clear(from);

      let totalSent = 0;
      for (const category of comboProducts) {
        console.log(`   Fetching images for category: ${category}`);
        const products = await findProductsByCategory(category, 3, from, false); // Get up to 3 products per category

        for (const product of products.slice(0, 1)) { // Send 1 image per category to keep it concise
          try {
            const originalUrl = product.images[0];
            const imageUrl = convertGoogleDriveUrl(originalUrl);

            if (isValidImageUrl(imageUrl)) {
              await sendWhatsAppImage(from, imageUrl, `${product.name} 🌿`);
              await sentImagesTracker.add(from, originalUrl);
              totalSent++;
              console.log(`   ✅ Sent: ${product.name}`);
              await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between images
            }
          } catch (err) {
            console.error(`   ❌ Failed to send ${product.name}:`, err.message);
          }
        }
      }

      console.log(`📦 Sent ${totalSent} images for combo products`);
      return; // Exit early after sending combo images
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
      // v53.27 CRITICAL FIX: ALWAYS require trigger words to prevent unsolicited image sending
      // Customer MUST explicitly ask for images using "show", "send", "share", "pictures", "images"
      // This prevents bot from sending images when customer only asks "Do you have planters?"

      if (pattern.test(userMessage) && hasTrigger) {
        catalogCategory = category;
        break;
      }
    }

    if (catalogCategory) {
      // v53.24 FIX: When customer explicitly asks for images, clear sent tracker
      // This allows re-sending images when customer says "share images", "send pictures", etc.
      if (hasTrigger && /\b(share|send|show|give)\b/i.test(messageBody)) {
        console.log('🔄 Explicit image request detected, clearing sent tracker for fresh images');
        await sentImagesTracker.clear(from); // Clear sent history for this customer
      }

      // v53.15 NEW: Extract size modifiers from message or conversation context
      let sizeFilter = null;
      const sizePattern = /\b(a5|a6|small|large|medium|mini|compact|jumbo|big)\b/i;

      // Check current message first
      const sizeMatch = userMessage.match(sizePattern);
      if (sizeMatch) {
        sizeFilter = sizeMatch[0].toLowerCase();
        console.log(`🔍 Size filter detected in message: "${sizeFilter}"`);
      } else {
        // Check recent conversation for size context
        const recentMessages = conversationContext.slice(-10);
        for (let i = recentMessages.length - 1; i >= 0; i--) {
          const msg = recentMessages[i];
          const content = msg.content || '';
          const contextSizeMatch = content.match(sizePattern);
          if (contextSizeMatch) {
            sizeFilter = contextSizeMatch[0].toLowerCase();
            console.log(`🔍 Size filter detected from conversation context: "${sizeFilter}"`);
            break;
          }
        }
      }

      // sentImagesTracker is managed per-URL via add/has/clear — no initialization needed

      // First try: Get new products excluding already sent
      let products = await findProductsByCategory(catalogCategory, 10, from, true);

      // v53.15 NEW: Apply size filter if specified
      if (sizeFilter && products.length > 0) {
        const originalCount = products.length;
        products = products.filter(p => {
          const nameLower = p.name.toLowerCase();
          const tagsLower = (p.tags || '').toLowerCase();

          // Check if product matches the size filter
          const matchesSize = nameLower.includes(sizeFilter) || tagsLower.includes(sizeFilter);

          if (matchesSize) {
            console.log(`   ✅ "${p.name}" matches size "${sizeFilter}"`);
          }
          return matchesSize;
        });

        console.log(`🔍 Size filter "${sizeFilter}" applied: ${originalCount} → ${products.length} products`);

        // If size filter eliminated all products, try without excludeSent flag
        if (products.length === 0) {
          console.log(`⚠️ No products match size "${sizeFilter}" in unsent products, checking all products...`);
          const allProducts = await findProductsByCategory(catalogCategory, 10, from, false);
          products = allProducts.filter(p => {
            const nameLower = p.name.toLowerCase();
            const tagsLower = (p.tags || '').toLowerCase();
            return nameLower.includes(sizeFilter) || tagsLower.includes(sizeFilter);
          });
          console.log(`🔍 Found ${products.length} products matching size "${sizeFilter}" (including previously sent)`);
        }
      }

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
        // v35: Added caddy, bar caddy - HORECA products without images in database
        const nonExistentCategories = ['mousepad', 'candles', 'caddy', 'bar caddy', 'bill folder', 'cork light']; // Products we don't have images for
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

            // v54.3: Try sending with retry on failure
            let imageSent = false;
            try {
              await sendWhatsAppImage(from, imageUrl, `${product.name} 🌿`);
              imageSent = true;
            } catch (sendErr) {
              console.log(`   ⚠️ Image send failed, retrying in 2s: ${sendErr.message}`);
              await new Promise(r => setTimeout(r, 2000));
              try {
                await sendWhatsAppImage(from, imageUrl, `${product.name} 🌿`);
                imageSent = true;
              } catch (retryErr) {
                console.log(`   ❌ Image send retry failed: ${retryErr.message}`);
              }
            }

            if (imageSent) {
              await sentImagesTracker.add(from, originalUrl); // Track only on confirmed success
              sentCount++;
              console.log(`   📸 Image send to ${from}: ✅ delivered - ${product.name} (${sentCount}/${products.length})`);
            } else {
              console.log(`   📸 Image send to ${from}: ❌ failed - ${product.name}`);
            }
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
        // v53.16 CRITICAL FIX: No JSON fallback! MongoDB is source of truth
        // If no products found, it means category truly doesn't exist or size filter too strict
        console.log(`❌ No products found for category "${catalogCategory}" in MongoDB`);
        console.log(`   This should be handled by AI via RULE 5C or by relaxing size filter`);
        // Don't send anything - let AI respond naturally without sending wrong products
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

      // v35: Check if user is asking for HORECA-specific products NOT in our image database
      // Products IN database (coasters, trays, etc.) → use images
      // Products NOT in database (caddy, bill folder, etc.) → send HORECA catalog
      const productsInDatabase = /\b(coasters?|trays?|diaries?|diary|planters?|bags?|wallets?|frames?|calendar|organizer|bottles?)\b/i;
      const horecaOnlyProducts = /\b(caddy|caddies|bar caddy|bill folder|bill folders|menu folder|menu folders|cork light|cork lights|trivets?|cork stool|cork stools)\b/i;
      const genericHorecaRequest = /\b(horeca|horeca products|horeca catalog|horeca catalogue)\b/i;

      // Only send HORECA catalog if asking for HORECA-specific products OR generic HORECA request
      // BUT NOT if they're asking for products we have in database (coasters, trays, etc.)
      const isHorecaSpecific = horecaOnlyProducts.test(userMessage) || genericHorecaRequest.test(userMessage);
      const hasProductInDB = productsInDatabase.test(userMessage);

      if (isHorecaSpecific && !hasProductInDB) {
        console.log('⚠️ HORECA-specific product requested - sending HORECA catalog PDF');
        if (CONFIG.PDF_CATALOG_HORECA) {
          try {
            await sendWhatsAppDocument(
              from,
              CONFIG.PDF_CATALOG_HORECA,
              '9Cork-HORECA-Catalog.pdf',
              'Here\'s our HORECA catalog with caddies, bar accessories & more! 🌿'
            );
            console.log('📄 HORECA catalog sent successfully');
          } catch (err) {
            console.error('❌ Failed to send HORECA catalog:', err.message);
          }
        }
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

// Per-phone message serialization (prevents race condition with rapid messages)
// When 3 messages arrive within seconds, each must wait for the previous to finish
// so context includes all prior messages
async function withPhoneLock(phone, fn) {
  const previousLock = phoneProcessingLock.get(phone);

  let resolveLock;
  const currentLock = new Promise(resolve => { resolveLock = resolve; });
  phoneProcessingLock.set(phone, currentLock);

  try {
    if (previousLock) {
      console.log(`⏳ Waiting for previous message from ${phone} to finish processing...`);
      await previousLock;
    }
    return await fn();
  } finally {
    resolveLock();
    if (phoneProcessingLock.get(phone) === currentLock) {
      phoneProcessingLock.delete(phone);
    }
  }
}

// Setup message processor (only called when queue is available)
function setupMessageProcessor() {
  if (!messageQueue) return;

  messageQueue.process('process-message', async (job) => {
    const { from, messageBody, messageId, messageType, mediaId } = job.data;

    await withPhoneLock(from, async () => {
    try {
      // v52 FIX: Check if we already sent a response to this message successfully
      if (sentResponses.has(messageId)) {
        const previousResponse = sentResponses.get(messageId);
        console.log(`✅ Message ${messageId} already processed successfully at ${previousResponse.timestamp.toISOString()}`);
        return;
      }

      console.log(`🔄 Processing ${messageType || 'text'} message from queue: ${from}`);

      // v35: Check for conversation reset request
      if (messageType !== 'image' && isResetRequest(messageBody)) {
        console.log(`🔄 Reset request detected in queue - clearing conversation history`);
        await clearConversationHistory(from);

        const freshGreeting = "👋 Fresh start! I'm Sita from 9 Cork Sustainable Products. What brings you here today - personal use, corporate gifting, or HORECA solutions?";
        await sendWhatsAppMessage(from, freshGreeting);
        await storeAgentMessage(from, freshGreeting);
        return;
      }

      // Get conversation context with timeout fallback
      let context = [];
      try {
        const contextPromise = getConversationContext(from);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Context timeout')), 4000)
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
        await storeCustomerMessage(from, `[IMAGE: ${messageBody || 'no caption'}]`, messageId).catch(err => console.error('⚠️ storeCustomerMessage failed (non-blocking):', err.message));
      } else {
        // Handle TEXT messages normally
        agentResponse = await processWithClaudeAgent(messageBody, from, context);
        await storeCustomerMessage(from, messageBody, messageId).catch(err => console.error('⚠️ storeCustomerMessage failed (non-blocking):', err.message));

        // v35: Auto-send HORECA catalog when HORECA-only products mentioned
        const horecaProducts = /\b(caddy|caddies|bar caddy|bill folder|bill folders|menu folder|menu folders|cork light|cork lights|trivets?|cork stool|cork stools)\b/i;
        if (horecaProducts.test(messageBody) && CONFIG.PDF_CATALOG_HORECA) {
          console.log('📄 Auto-sending HORECA catalog (HORECA product mentioned)');
          try {
            await sendWhatsAppDocument(
              from,
              CONFIG.PDF_CATALOG_HORECA,
              '9Cork-HORECA-Catalog.pdf',
              'Here\'s our HORECA catalog with details on this product!'
            );
          } catch (err) {
            console.error('❌ Failed to auto-send HORECA catalog:', err.message);
          }
        }
      }

      // Send response back to customer
      await sendWhatsAppMessage(from, agentResponse);

      // v52 FIX: Mark message as successfully sent
      sentResponses.set(messageId, {
        timestamp: new Date(),
        responseText: agentResponse.substring(0, 100),
        phoneNumber: from
      });

      // Handle image detection and sending
      await handleImageDetectionAndSending(from, agentResponse, messageBody, context);

      // Store agent response in database
      await storeAgentMessage(from, agentResponse).catch(err => console.error('⚠️ storeAgentMessage failed (non-blocking):', err.message));

      // v53.19: Extract and save conversation metadata
      await extractAndSaveMetadata(from, messageBody, agentResponse, context).catch(err => console.error('⚠️ extractAndSaveMetadata failed (non-blocking):', err.message));

      console.log('✅ Message processed successfully');
    } catch (error) {
      console.error('❌ Error processing message:', error);
      if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
      await sendWhatsAppMessage(from, "Sorry, I'm experiencing technical difficulties. Please try again in a moment.");
    }
    }); // end withPhoneLock
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

// Admin endpoints rate limiter (strict — only 5 requests per minute)
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 5,
  message: { error: 'Too many admin requests' }
});

// FIX #4: Per-Phone Rate Limiting (prevents spam from individual users)
const phoneRateLimits = new Map();

// v49: Message deduplication cache (prevent processing same message twice)
// Meta sometimes sends duplicate webhooks for reliability - causes duplicate AI responses
// TTL-based Map: replaces size-based Set clear to avoid wiping recent IDs
class MessageDeduplicator {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.store = new Map(); // id -> timestamp
  }

  add(id) {
    this.store.set(id, Date.now());
  }

  has(id) {
    const ts = this.store.get(id);
    if (!ts) return false;
    if (Date.now() - ts > this.ttlMs) {
      this.store.delete(id);
      return false;
    }
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [id, ts] of this.store) {
      if (now - ts > this.ttlMs) {
        this.store.delete(id);
      }
    }
  }

  clear() {
    this.store.clear();
  }

  get size() { return this.store.size; }
}

const MESSAGE_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const processedMessageIds = new MessageDeduplicator(MESSAGE_DEDUP_TTL);

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

  // v49: Clean up message deduplication cache (TTL-based, removes only expired entries)
  processedMessageIds.cleanup();

  // Clean up sentResponses map (prevent unbounded memory growth on long-running server)
  for (const [msgId, data] of sentResponses.entries()) {
    if (now - data.timestamp.getTime() > cleanupAge) {
      sentResponses.delete(msgId);
    }
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

      // v35: Check for conversation reset request
      if (messageType === 'text' && isResetRequest(messageBody)) {
        console.log(`[${requestId}] 🔄 Reset request detected - clearing conversation history`);
        await clearConversationHistory(from);

        // Send fresh greeting
        const freshGreeting = "👋 Fresh start! I'm Sita from 9 Cork Sustainable Products. What brings you here today - personal use, corporate gifting, or HORECA solutions?";
        await sendWhatsAppMessage(from, freshGreeting);

        // Store the fresh greeting
        await storeAgentMessage(from, freshGreeting);

        console.log(`[${requestId}] ✅ Conversation reset complete - fresh greeting sent`);
        return;
      }

      // Process text messages AND image messages
      // v54: Optimized bot available at /webhook-optimized for testing
      // Main webhook uses original code for stability
      if ((messageType === 'text' && messageBody) || messageType === 'image') {
        // Add to queue for processing (if queue is available)
        if (messageQueue) {
          await messageQueue.add('process-message', {
            from,
            messageBody: messageBody || 'What is this?',
            messageId,
            messageType,
            mediaId,
            timestamp: new Date()
          });
          console.log('✅ Message added to queue');
        } else {
          console.log('⚠️  Queue unavailable - processing directly');

          // v52 FIX: Check if already sent
          if (sentResponses.has(messageId)) {
            const previousResponse = sentResponses.get(messageId);
            console.log(`✅ Message ${messageId} already sent at ${previousResponse.timestamp.toISOString()}`);
            return;
          }

          // Process directly without queue (serialized per-phone)
          await withPhoneLock(from, async () => {
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
              await storeCustomerMessage(from, `[IMAGE: ${messageBody || 'no caption'}]`, messageId).catch(() => {});
            } else {
              // Handle TEXT messages normally
              response = await processWithClaudeAgent(messageBody, from, context);
              await storeCustomerMessage(from, messageBody, messageId).catch(() => {});

              // v35: Auto-send HORECA catalog when HORECA-only products mentioned
              const horecaProducts = /\b(caddy|caddies|bar caddy|bill folder|bill folders|menu folder|menu folders|cork light|cork lights|trivets?|cork stool|cork stools)\b/i;
              if (horecaProducts.test(messageBody) && CONFIG.PDF_CATALOG_HORECA) {
                console.log('📄 Auto-sending HORECA catalog (HORECA product mentioned)');
                try {
                  await sendWhatsAppDocument(
                    from,
                    CONFIG.PDF_CATALOG_HORECA,
                    '9Cork-HORECA-Catalog.pdf',
                    'Here\'s our HORECA catalog with details on this product!'
                  );
                } catch (err) {
                  console.error('❌ Failed to auto-send HORECA catalog:', err.message);
                }
              }
            }

            await sendWhatsAppMessage(from, response);
            await handleImageDetectionAndSending(from, response, messageBody, context);
            await storeAgentMessage(from, response).catch(() => {});

          } catch (err) {
            console.error('Error processing message:', err);
            if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
            await sendWhatsAppMessage(
              from,
              "Sorry, I'm experiencing technical difficulties. Please try again in a moment."
            ).catch(e => console.error('Failed to send error message:', e));
          }
          }); // end withPhoneLock
        }
      }
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN-OPTIMIZED WEBHOOK (3-Agent Architecture)
// ═══════════════════════════════════════════════════════════════════════════════
// Route: POST /webhook-optimized
// Token savings: 70-85% (800-2000 tokens -> ~255 tokens per message)
// Components: Router Agent (~80 tokens) + State Manager (0 tokens) + Responder (~175 tokens)
// ═══════════════════════════════════════════════════════════════════════════════

// Initialize optimized bot instance
let optimizedBot = null;

async function getOrInitOptimizedBot() {
  if (!optimizedBot) {
    optimizedBot = getOptimizedBot({
      GROQ_API_KEY: CONFIG.GROQ_API_KEY,
      GROQ_API_KEY_2: CONFIG.GROQ_API_KEY_2,
      GROQ_API_KEY_3: CONFIG.GROQ_API_KEY_3,
      GROQ_API_KEY_4: CONFIG.GROQ_API_KEY_4,
      WHATSAPP_TOKEN: CONFIG.WHATSAPP_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: CONFIG.WHATSAPP_PHONE_NUMBER_ID,
      PDF_CATALOG_HORECA: CONFIG.PDF_CATALOG_HORECA,
      PDF_CATALOG_PRODUCTS: CONFIG.PDF_CATALOG_PRODUCTS,
      PDF_CATALOG_COMBOS: CONFIG.PDF_CATALOG_COMBOS
    });

    // Set send message function
    optimizedBot.setSendMessageFunction(sendWhatsAppMessage);

    // Initialize
    await optimizedBot.initialize();
    console.log('✅ Token-Optimized Bot initialized');
  }
  return optimizedBot;
}

// Webhook verification for optimized endpoint (same as main)
app.get('/webhook-optimized', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === CONFIG.VERIFY_TOKEN) {
      console.log('✅ Optimized webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(403);
  }
});

// Token-optimized webhook handler
app.post('/webhook-optimized', webhookLimiter, validateWebhookSignature, async (req, res) => {
  console.log('📨 [OPTIMIZED] Incoming webhook');

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

      const requestId = generateRequestId();
      console.log(`[${requestId}] 📨 [OPTIMIZED] Message from ${from.slice(-4)} (${messageType})`);

      // Message deduplication
      if (processedMessageIds.has(messageId)) {
        console.log(`[${requestId}] 🔄 Duplicate message - skipping`);
        return;
      }
      processedMessageIds.add(messageId);

      // Validate message
      const validation = validateWhatsAppMessage(message);
      if (!validation.valid) {
        console.warn(`[${requestId}] ❌ Invalid message: ${validation.error}`);
        return;
      }

      // Rate limit check
      const rateLimitCheck = checkPhoneRateLimit(from, messageBody);
      if (rateLimitCheck === 'silent_drop') {
        console.log(`[${requestId}] 💡 Silently dropping rapid message`);
        return;
      }

      // Check for reset request
      if (messageType === 'text' && isResetRequest(messageBody)) {
        console.log(`[${requestId}] 🔄 Reset request detected`);
        const bot = await getOrInitOptimizedBot();
        await bot.resetConversation(from);

        const freshGreeting = "👋 Fresh start! I'm Sita from 9 Cork. What brings you here - personal use, corporate gifting, or HORECA?";
        await sendWhatsAppMessage(from, freshGreeting);
        return;
      }

      // Process with optimized bot
      if ((messageType === 'text' && messageBody) || messageType === 'image') {
        await withPhoneLock(from, async () => {
          try {
            const bot = await getOrInitOptimizedBot();

            // Process message
            const result = await bot.processMessage(
              from,
              messageBody || '[IMAGE]',
              messageType,
              mediaId
            );

            console.log(`[${requestId}] [OPTIMIZED] Node: ${result.node}, Latency: ${result.latency}ms`);

            // Send response
            await sendWhatsAppMessage(from, result.response);

            // Handle auto-send HORECA catalog for HORECA products
            if (result.node === 'HORECA' && CONFIG.PDF_CATALOG_HORECA) {
              const horecaProducts = /\b(caddy|caddies|bar caddy|bill folder|bill folders|menu folder|menu folders|cork light|cork lights|trivets?|cork stool|cork stools)\b/i;
              if (horecaProducts.test(messageBody)) {
                console.log(`[${requestId}] 📄 Auto-sending HORECA catalog`);
                try {
                  await sendWhatsAppDocument(
                    from,
                    CONFIG.PDF_CATALOG_HORECA,
                    '9Cork-HORECA-Catalog.pdf',
                    'Here\'s our HORECA catalog!'
                  );
                } catch (err) {
                  console.error('❌ Failed to send HORECA catalog:', err.message);
                }
              }
            }

            // Store messages in main conversation DB (for cross-system compatibility)
            await storeCustomerMessage(from, messageBody || '[IMAGE]', messageId).catch(() => {});
            await storeAgentMessage(from, result.response).catch(() => {});

            // Extract metadata for 4-day memory
            const context = await bot.stateManager.getRecentMessages(from);
            await extractAndSaveMetadata(from, messageBody, result.response, context).catch(() => {});

          } catch (err) {
            console.error(`[${requestId}] [OPTIMIZED] Error:`, err.message);

            // Fallback: Route to existing bot on error
            console.log(`[${requestId}] 🔄 Falling back to standard bot`);

            try {
              const context = await getConversationContext(from);
              const response = await processWithClaudeAgent(messageBody || '[IMAGE]', from, context);
              await sendWhatsAppMessage(from, response);
              await storeCustomerMessage(from, messageBody || '[IMAGE]', messageId).catch(() => {});
              await storeAgentMessage(from, response).catch(() => {});
            } catch (fallbackErr) {
              console.error(`[${requestId}] Fallback also failed:`, fallbackErr.message);
              await sendWhatsAppMessage(from, "I'm having trouble. Please try again.").catch(() => {});
            }
          }
        });
      }
    }
  } catch (error) {
    console.error('❌ [OPTIMIZED] Error processing webhook:', error);
    if (CONFIG.SENTRY_DSN) Sentry.captureException(error);
  }
});

// Stats endpoint for optimized bot
app.get('/optimized-stats', async (req, res) => {
  try {
    const bot = await getOrInitOptimizedBot();
    const stats = bot.getStats();
    res.json({
      status: 'ok',
      healthy: bot.isHealthy(),
      stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// END TOKEN-OPTIMIZED WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════════

// v53.19: Extract and save conversation metadata for cross-session memory (4 days)
async function extractAndSaveMetadata(phoneNumber, customerMessage, agentResponse, context) {
  try {
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    // Find active conversation
    const conversation = await Conversation.findOne({
      customerPhone: { $eq: sanitizedPhone },
      status: 'active'
    });

    if (!conversation) return; // No conversation to update

    // Extract information from customer message + context
    const recentText = `${customerMessage} ${agentResponse} ${context.slice(-3).map(m => m.content).join(' ')}`.toLowerCase();

    // Initialize metadata if not exists
    if (!conversation.metadata) {
      conversation.metadata = {
        productInterest: [],
        budget: null,
        quantity: null,
        timeline: null
      };
    }

    // Extract PRODUCTS mentioned (coasters, diaries, combos, etc.)
    const productPatterns = {
      'coasters': /\b(coaster|coasters)\b/i,
      'diaries': /\b(diary|diaries|notebook)\b/i,
      'combos': /\b(combo|combos|gifting|gift box)\b/i,
      'calendars': /\b(calendar|calender)\b/i,
      'desk organizers': /\b(desk organizer|organizer|pen holder)\b/i,
      'planters': /\b(planter|planters)\b/i,
      'bags': /\b(bag|bags|laptop bag|wallet)\b/i,
      'trays': /\b(tray|trays|serving tray)\b/i
    };

    for (const [product, pattern] of Object.entries(productPatterns)) {
      if (pattern.test(recentText) && !conversation.metadata.productInterest.includes(product)) {
        conversation.metadata.productInterest.push(product);
      }
    }

    // Extract BUDGET (below 700, under 500, etc.)
    const budgetMatch = recentText.match(/\b(?:below|under|around|budget)\s*(?:rs\.?|₹)?\s*(\d+)/i);
    if (budgetMatch) {
      conversation.metadata.budget = `₹${budgetMatch[1]} per piece`;
    }

    // Extract QUANTITY (100 pcs, 50 pieces, 200 nos, etc.)
    const quantityMatch = recentText.match(/(\d+)\s*(?:pcs?|pieces?|nos?|units?|combos?)/i);
    if (quantityMatch) {
      conversation.metadata.quantity = parseInt(quantityMatch[1]);
    }

    // Extract TIMELINE (urgent, next week, by friday, etc.)
    if (/\b(urgent|asap|today|tomorrow)\b/i.test(recentText)) {
      conversation.metadata.timeline = 'urgent';
    } else if (/\b(next week|this week)\b/i.test(recentText)) {
      conversation.metadata.timeline = 'this week';
    }

    // Save updated metadata
    await conversation.save();
    console.log(`💾 Metadata saved: products=${conversation.metadata.productInterest.join(',')}, budget=${conversation.metadata.budget}, qty=${conversation.metadata.quantity}`);

  } catch (error) {
    console.error('❌ Error extracting metadata:', error.message);
  }
}

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

// v35: Clear conversation history for fresh start
async function clearConversationHistory(phoneNumber) {
  const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

  try {
    // Clear in-memory cache
    if (conversationMemory.has(sanitizedPhone)) {
      conversationMemory.delete(sanitizedPhone);
      console.log(`🗑️ Cleared in-memory history for ${sanitizedPhone}`);
    }

    // Mark MongoDB conversation as completed (preserve for analytics)
    try {
      await Conversation.updateOne(
        { customerPhone: sanitizedPhone, status: 'active' },
        { $set: { status: 'completed', completedAt: new Date() } }
      );
      console.log(`🗑️ Marked MongoDB conversation as completed for ${sanitizedPhone}`);
    } catch (mongoError) {
      console.log('⚠️ MongoDB clear skipped:', mongoError.message);
    }

    return true;
  } catch (error) {
    console.error('❌ Error clearing conversation:', error.message);
    return false;
  }
}

// Detect if user wants to start fresh
function isResetRequest(message) {
  const resetPatterns = /\b(fresh chat|new chat|start over|start fresh|from scratch|reset|clear chat|new conversation|begin again|restart|new requirement|fresh requirement)\b/i;
  return resetPatterns.test(message);
}

// v54.4: Build context-aware message with known facts to prevent repeated questions
// CRITICAL: Only extract from RECENT messages and respect topic changes
function buildContextAwareMessage(userMessage, conversationHistory) {
  // Only use last 6 messages to avoid stale context contamination
  const recentHistory = conversationHistory.slice(-6);

  // Detect topic change / product switch in recent user messages
  const TOPIC_CHANGE = /\b(no longer|not needed|cancel|don't need|instead|switch to|different|fresh chat|new chat|start over|start fresh|from scratch|not required|forget|ignore)\b/i;

  // Find the most recent topic change point
  let startIdx = 0;
  for (let i = 0; i < recentHistory.length; i++) {
    if (recentHistory[i].role === 'user' && TOPIC_CHANGE.test(recentHistory[i].content)) {
      startIdx = i + 1; // Only use messages AFTER the topic change
    }
  }

  // Only extract facts from messages after the last topic change (user messages only)
  const relevantMessages = recentHistory.slice(startIdx).filter(m => m.role === 'user');
  if (relevantMessages.length === 0) return userMessage;

  const recentText = relevantMessages.map(m => m.content).join(' ').toLowerCase();

  // Detect the CURRENT product from user's most recent message first, then recent context
  const PRODUCT_RE = /\b(coasters?|diary|diaries|planters?|organizers?|calend[ae]rs?|bags?|wallets?|frames?|photo frames?|trays?|combos?|bottles?|clocks?|lamps?)\b/i;
  const currentProductMatch = userMessage.match(PRODUCT_RE);
  const contextProductMatch = recentText.match(PRODUCT_RE);
  const activeProduct = currentProductMatch ? currentProductMatch[0] : (contextProductMatch ? contextProductMatch[0] : null);

  const facts = [];

  // Extract product
  if (activeProduct) facts.push(`PRODUCT: ${activeProduct}`);

  // Extract quantity (only from recent relevant messages)
  const qtyMatch = recentText.match(/(\d+)\s*(?:pcs|pieces|nos|people|units|qty|quantity|numbers?)/i);
  if (qtyMatch) facts.push(`QUANTITY: ${qtyMatch[1]}`);

  // Extract budget (only from recent relevant messages)
  const budgetMatch = recentText.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*)/i);
  if (budgetMatch) facts.push(`BUDGET: ₹${budgetMatch[1]}`);

  // Extract use case / occasion (only from recent relevant messages)
  if (/gift|gifting|event|occasion|corporate|wedding|birthday|anniversary|diwali|christmas/.test(recentText)) {
    const match = recentText.match(/(?:for|gift.*?for|occasion.*?is|it'?s?\s+(?:for|a))\s+([^.!?\n]{3,40})/i);
    if (match) facts.push(`USE CASE: ${match[1].trim()}`);
  }

  // Extract timeline (only from recent relevant messages)
  const timelineMatch = recentText.match(/\b(next week|this month|urgent|asap|year.?end|quarter|diwali|christmas|by \w+)\b/i);
  if (timelineMatch) facts.push(`TIMELINE: ${timelineMatch[0]}`);

  if (facts.length > 0) {
    console.log(`📋 Context facts extracted (last ${relevantMessages.length} msgs): ${facts.join(', ')}`);
    return `[ALREADY KNOWN: ${facts.join(', ')}]\n\n${userMessage}`;
  }
  return userMessage;
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

    // v53.20: Get conversation metadata for cross-session memory (4 days)
    let conversationMetadata = null;
    try {
      const conversation = await Conversation.findOne({
        customerPhone: { $eq: sanitizedPhone },
        status: 'active'
      });

      if (conversation && conversation.metadata) {
        conversationMetadata = conversation.metadata;
        console.log(`💾 Using previous conversation metadata: products=${conversationMetadata.productInterest?.join(',') || 'none'}, budget=${conversationMetadata.budget || 'none'}`);
      }
    } catch (metaError) {
      console.warn('⚠️ Failed to load metadata:', metaError.message);
      // Continue without metadata - not critical
    }

    // v54.4: Only inject previous conversation metadata at conversation start (first 2 messages)
    // and suppress when customer signals fresh start
    const isFreshStart = /\b(fresh|new chat|start over|start fresh|from scratch|fresh chat|reset)\b/i.test(message);
    const isConversationStart = context.length <= 2;
    const useMetadata = isConversationStart && !isFreshStart ? conversationMetadata : null;
    if (isFreshStart) console.log('🔄 Fresh start detected - suppressing previous metadata');
    if (!isConversationStart) console.log(`📊 Mid-conversation (${context.length} msgs) - skipping "Welcome back" metadata`);
    const systemPrompt = buildSystemPrompt(useMetadata);

    // RAG: retrieve relevant past conversations (graceful fallback if disabled/failed)
    let ragContext = '';
    if (CONFIG.RAG_ENABLED) {
      try {
        const retrieval = await retrieveContext({
          message: sanitizedMessage,
          customerPhone: sanitizedPhone,
          timeoutMs: CONFIG.RAG_RETRIEVAL_TIMEOUT_MS
        });
        ragContext = buildRagContext(retrieval);
        if (retrieval.usedRAG) {
          console.log(`📚 RAG: ${retrieval.similarConversations.length} similar, ${retrieval.customerHistory.length} customer history`);
        }
      } catch (err) {
        console.warn('⚠️ RAG retrieval failed (continuing without):', err.message);
      }
    }

    // v54.4: Build context-aware message with known facts to prevent repeated questions
    const contextAwareMessage = buildContextAwareMessage(sanitizedMessage, context);

    // Use multi-provider AI manager with automatic failover
    // Send last 50 messages for context (optimized for Groq upper tier 32k+ token limit)
    // v54.3: Use context-aware message (with [ALREADY KNOWN: ...] prefix) as the current message
    const contextWithFacts = [...context, { role: 'user', content: contextAwareMessage }];
    const result = await aiManager.getResponse(
      systemPrompt, // v53.20: Now dynamic based on previous conversation!
      contextWithFacts.slice(-50), // Last 50 messages (including new message with facts)
      contextAwareMessage,
      sanitizedPhone,  // Pass userId for cache isolation (prevents cross-user cache contamination)
      ragContext  // RAG-augmented context (empty string if RAG_ENABLED=false)
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

    // Cap total in-memory map size (evict oldest entry when over 500 customers)
    if (conversationMemory.size > 500) {
      const oldestKey = conversationMemory.keys().next().value;
      conversationMemory.delete(oldestKey);
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
      // v53.32: Don't fallback to direct URL for size errors (WhatsApp will reject anyway)
      if (result.isSizeError) {
        console.error('❌ Image too large even after compression, cannot send');
        throw new Error(`Image too large to send via WhatsApp: ${result.error}`);
      }
      console.log('⚠️ Media Upload failed (non-size error), trying direct URL fallback...');
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
    version: 'v35-GEMINI-MULTI-KEY',
    providers: {
      groq: aiManager.groqClients ? aiManager.groqClients.length : 0,
      gemini: aiManager.geminiKeys ? aiManager.geminiKeys.length : 0
    },
    services: {
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      queue: messageQueue ? 'active' : 'inactive'
    }
  };

  res.json(health);
});

// Vision API health check (v53.29 - NEW, v53.30 - shows multiple Gemini keys)
app.get('/health/vision', monitoringLimiter, async (req, res) => {
  // v53.30: Count Gemini keys
  const geminiKeys = CONFIG.GEMINI_API_KEY
    ? CONFIG.GEMINI_API_KEY.split(',').map(k => k.trim()).filter(Boolean)
    : [];

  const visionHealth = {
    timestamp: new Date().toISOString(),
    providers: {
      gemini: geminiKeys.length > 0,
      geminiKeysCount: geminiKeys.length,
      claude: !!CONFIG.ANTHROPIC_API_KEY,
      googleCloud: !!CONFIG.GOOGLE_CLOUD_VISION_KEY,
      huggingFace: !!CONFIG.HUGGINGFACE_TOKEN
    },
    stats: visionHandler.getStats()
  };

  // Calculate overall status
  const workingProviders = [
    geminiKeys.length > 0,
    !!CONFIG.ANTHROPIC_API_KEY,
    !!CONFIG.GOOGLE_CLOUD_VISION_KEY,
    !!CONFIG.HUGGINGFACE_TOKEN
  ].filter(Boolean).length;

  visionHealth.status = workingProviders === 0 ? 'critical' :
                        workingProviders < 2 ? 'degraded' :
                        workingProviders < 4 ? 'partial' : 'healthy';
  visionHealth.workingProviders = workingProviders;
  visionHealth.totalProviders = 4;

  res.json(visionHealth);
});

// Stats endpoint (SECURITY: Rate limited to 60 req/min)
app.get('/stats', monitoringLimiter, async (req, res) => {
  try {
    const totalCustomers = await Customer.countDocuments();
    const activeConversations = await Conversation.countDocuments({ status: 'active' });

    // Guard: queue may be null if Redis is unavailable
    const queueStats = messageQueue
      ? await messageQueue.getJobCounts()
      : { waiting: 0, active: 0, completed: 0, failed: 0 };

    res.json({
      customers: totalCustomers,
      activeConversations,
      queue: queueStats,
      queueAvailable: !!messageQueue
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Error retrieving stats' });
  }
});

// Admin endpoint: Clear all products from database
app.post('/admin/clear-products', adminLimiter, async (req, res) => {
  try {
    console.log('📥 Admin clear endpoint called');

    // Authentication using ADMIN_SECRET (separate from webhook VERIFY_TOKEN)
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!CONFIG.ADMIN_SECRET) {
      console.error('❌ ADMIN_SECRET not configured — admin endpoint is locked');
      return res.status(503).json({ error: 'Admin endpoint not configured' });
    }
    if (token !== CONFIG.ADMIN_SECRET) {
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
app.post('/admin/import-products', adminLimiter, async (req, res) => {
  try {
    console.log('📥 Admin import endpoint called');

    // Authentication using ADMIN_SECRET (separate from webhook VERIFY_TOKEN)
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!CONFIG.ADMIN_SECRET) {
      console.error('❌ ADMIN_SECRET not configured — admin endpoint is locked');
      return res.status(503).json({ error: 'Admin endpoint not configured' });
    }
    if (token !== CONFIG.ADMIN_SECRET) {
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

  // Validate admin configuration
  if (!CONFIG.ADMIN_SECRET) {
    console.warn('⚠️ WARNING: ADMIN_SECRET is not set. Admin endpoints are locked but misconfigured. Set ADMIN_SECRET env var.');
  }

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

  // sentImagesTracker: Redis handles TTL expiry automatically (30-minute TTL per key)
  console.log('🧹 sentImagesTracker: Redis handles TTL expiry automatically');

  // Log memory stats
  const totalConversations = conversationMemory.size;
  const memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  console.log(`📊 Active conversations: ${totalConversations}, Memory: ${memoryMB}MB`);
}, 30 * 60 * 1000); // Every 30 minutes

// Initial cleanup after 5 minutes
setTimeout(() => {
  console.log('🧹 Running initial memory cleanup...');
  const initialSize = conversationMemory.size;
  console.log(`📊 Initial conversation memory: ${initialSize} entries`);
}, 5 * 60 * 1000);

// v53.20: Archive conversations older than 4 days
setInterval(async () => {
  try {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

    const result = await Conversation.updateMany(
      {
        status: 'active',
        lastMessageAt: { $lt: fourDaysAgo }
      },
      {
        $set: { status: 'archived' }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`📦 Archived ${result.modifiedCount} conversations older than 4 days`);
    }
  } catch (error) {
    console.error('❌ Conversation archiving failed:', error.message);
  }
}, 12 * 60 * 60 * 1000); // Every 12 hours

// Export for testing
module.exports = {
  app,
  calculateReconnectDelay,
  convertGoogleDriveUrl,
  isValidImageUrl,
  validateWhatsAppMessage,
  checkPhoneRateLimit,
  isResetRequest,
  buildContextAwareMessage,
  buildSystemPrompt,
  validateWebhookSignature,
  handleImageDetectionAndSending,
  findProductsByCategory,
  findProductBySearch,
  withPhoneLock,
  processWithClaudeAgent,
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendWhatsAppDocument,
  storeCustomerMessage,
  storeAgentMessage,
  getConversationContext,
  clearConversationHistory,
  extractAndSaveMetadata,
  // Token-optimized bot
  getOrInitOptimizedBot,
  // Internal state (for testing)
  CONFIG,
  sentImagesTracker,
  phoneProcessingLock,
  processedMessageIds,
  sentResponses,
  conversationMemory,
  phoneRateLimits,
  // MessageDeduplicator class (for testing)
  MessageDeduplicator
};
