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
const StateLog = require('./models/StateLog');
// v60 — Path B deterministic pricing
const { computeQuote, formatQuoteForCustomer } = require('./pricing/quote-engine');
// LLM-first intent resolution (2026-07-05 spec). Regex extractor is now the
// resolver's internal fallback — server.js no longer calls it directly.
const { resolveIntent, getResolverStats } = require('./pricing/intent-resolver');
// v61 Phase B.1 — conversation state machine (read-only guard layer)
const { deriveState: deriveConversationState, deriveStateAsync } = require('./pricing/conversation-state');
// v61 Phase B.2 — state enforcer (post-LLM action-allowlist + surgical stripping)
const { enforce: enforceState, extractRupeeAmounts } = require('./pricing/state-enforcer');
// v60 — comprehensive image-category routing
const { resolveCategory: resolveImageCategory } = require('./pricing/image-routing');
// 2026-07-06 — intent-driven image selection: images narrow by the resolver's
// refinements, same understanding layer as pricing.
const { filterByRefinements, selectImageSearch } = require('./pricing/refinement-filter');
// v60 — voice message transcription via Groq Whisper
const { handleVoiceMessage } = require('./audio-handler');
// v60 — catalog-aware vision identification via Gemini multimodal
const { identifyProductFromImage } = require('./pricing/vision-identifier');
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
const { pushLeadEvent: pushBiginEvent, isConfigured: biginConfigured } = require('./integrations/bigin');
const { detectOutcome } = require('./rag/outcome-detector');

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
// v59 — RULE G escalation detector
// Matches the canonical holding phrases the bot uses when a question is outside
// catalog/prompt knowledge. Used to tag conversations that need human follow-up.
const ESCALATION_PATTERNS = [
  /\blet me check with (?:our|the) team\b/i,
  /\bi(?:'ll| will) check with (?:our|the) team\b/i,
  /\blet me confirm with (?:our|the) team\b/i,
  /\bcheck with (?:our|the) team and come back to you\b/i,
  /\bcome back to you within a few hours\b/i,
  /\bi(?:'ll| will) get back to you\b/i,
  /\bneed to confirm with (?:our|the) team\b/i
];

function isEscalation(text) {
  if (!text || typeof text !== 'string') return false;
  return ESCALATION_PATTERNS.some(re => re.test(text));
}

// v59 — Sanitize bot reply before sending to customer AND before storing.
// Two passes:
//   1. Strip LLM chat-template control tokens (Llama/Groq sometimes leak these
//      mid-response, e.g. <|start_header_id|>assistant<|end_header_id|>). If
//      such a marker appears, truncate at the marker so no garbage reaches
//      the customer.
//   2. Round all ₹ decimal amounts to whole rupees (₹196.88 → ₹197) so the
//      customer never sees paise AND the stored message has clean numbers
//      (prevents the feedback loop where one verbose reply seeds the next 50).
const CONTROL_TOKEN_PATTERNS = [
  /<\|start_header_id\|>[\s\S]*$/i,  // truncate at this marker
  /<\|end_header_id\|>[\s\S]*$/i,
  /<\|eot_id\|>[\s\S]*$/i,
  /<\|begin_of_text\|>[\s\S]*$/i,
  /<\|im_start\|>[\s\S]*$/i,
  /<\|im_end\|>[\s\S]*$/i,
  /<\|reserved_special_token_\d+\|>[\s\S]*$/i
];

function sanitizeBotReply(text) {
  if (!text || typeof text !== 'string') return text;

  // v61 (Single-Brain): the sanitizer now does only what it must — strip LLM
  // control-token leaks (a real Groq/Llama bug) and round any stray decimals
  // to whole rupees. The 9-pattern disclosure-phrase stripper is GONE — the
  // prompt no longer trains the LLM on MRPs or discount math, so there's
  // nothing to leak. As a belt-and-suspenders defense we still strip one
  // pattern: a literal "(MRP ₹X)" parenthetical, in case the LLM ever picks
  // that format up from elsewhere.

  // Detect LLM control-token leak (Llama on Groq sometimes does this)
  const hadControlToken = CONTROL_TOKEN_PATTERNS.some(re => re.test(text));

  // Pass 1: strip control tokens — truncate AT the marker since anything
  // after a leaked marker is unreliable garbage.
  let cleaned = text;
  for (const re of CONTROL_TOKEN_PATTERNS) {
    cleaned = cleaned.replace(re, '');
  }
  cleaned = cleaned.trim();

  // Recovery: if control-token stripping left us with a useless short fragment,
  // replace with a recoverable message so the customer can re-prompt.
  if (hadControlToken && cleaned.length < 50) {
    console.warn(`⚠️ Bot reply truncated by control-token leak (${cleaned.length} chars). Falling back.`);
    cleaned = "Sorry, I got cut off there — could you repeat your last message?";
  }

  // Pass 2: belt-and-suspenders — strip "(MRP ₹X)" parenthetical only.
  // The new prompt doesn't teach this format, but if it appears we drop it.
  cleaned = cleaned.replace(/\s*\(\s*MRP\s+₹\s*[\d,]+(?:\.\d+)?\s*\)/gi, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();

  // Pass 3: round all ₹ decimal amounts to whole rupees.
  // (Engine already returns whole rupees, this is final defense.)
  cleaned = cleaned.replace(/₹\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?/g, (match) => {
    const numStr = match.replace(/[₹,\s]/g, '');
    const num = parseFloat(numStr);
    if (isNaN(num)) return match;
    return '₹' + Math.round(num).toLocaleString('en-IN');
  });

  return cleaned;
}

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
  PDF_CATALOG_TROPHY: (process.env.PDF_CATALOG_TROPHY || '').trim(),
  PDF_CATALOG_YOGA: (process.env.PDF_CATALOG_YOGA || '').trim(),
  PDF_CATALOG_PLANTERS: (process.env.PDF_CATALOG_PLANTERS || '').trim(),
  PDF_CATALOG_ELEVATION: (process.env.PDF_CATALOG_ELEVATION || '').trim(),
  PDF_CATALOG_MINIMALIST: (process.env.PDF_CATALOG_MINIMALIST || '').trim(),
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
  WEEKLY_REPORT_ENABLED: process.env.WEEKLY_REPORT_ENABLED === 'true',
  PRICING_SYNC_ENABLED: process.env.PRICING_SYNC_ENABLED === 'true',
  // Bigin (Zoho CRM) — set BIGIN_ENABLED=true on Render + provide OAuth creds to activate
  BIGIN_ENABLED: process.env.BIGIN_ENABLED === 'true',
  BIGIN_DC: (process.env.BIGIN_DC || 'in').trim()
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
  // Mask DSN in logs (security) — show only project ID portion
  const dsnMatch = CONFIG.SENTRY_DSN.match(/\/(\d+)$/);
  console.log(`✅ Sentry initialized (project ID: ${dsnMatch ? dsnMatch[1] : 'unknown'}, env: ${CONFIG.NODE_ENV})`);
} else {
  console.log(`⚠️ Sentry NOT initialized — SENTRY_DSN env var is not set`);
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
    const TRIGGER_WORDS = /\b(show|send(?:ing)?|share|reshare|resend|re-share|re-send)\b.*\b(picture|pictures|photo|photos|image|images)\b|\b(picture|pictures|photo|photos|image|images)\b.*\b(show|send(?:ing)?|share|reshare|resend|re-share|re-send)\b/i;
    // v54.3: Option-sharing patterns - catches "share options", "show all", "send varieties"
    const OPTION_TRIGGERS = /\b(share|show|send|reshare|resend)\b.*\b(options?|varieties?|range|collection|types?|all)\b/i;
    // v54.3: Resend detection - clears sent tracker when customer didn't receive images
    const RESEND_PATTERN = /\b(reshare|resend|again|re-share|re-send|pls share|please share|didn'?t get|not received|haven'?t received)\b/i;
    // v60 — keyword regex aligned with the live catalog. Added: mirror, yoga,
    // caddy, bar, stool, lamp, scanner, tag, napkin, tissue, ring, brick,
    // ball, roller, clock, trophy, hot plate, soil, hanging light, menu folder,
    // bill folder. This ensures every catalog category triggers image detection
    // (and then either sends correct images OR falls through to the
    // nonExistentCategories safety net below).
    const PRODUCT_KEYWORDS = /(13inch|15inch|3in1|3inone|4pcs|accessory|and|aqua|bag|ball|bar|bifold|bill|bohemian|bottle|bottles|box|breakfast|brick|bridge|business|caddy|caddies|calendar|candle|card|case|catchall|chiller|chip|choco|chocochip|clock|clocks|clutch|coaster|coasters|combo|cube|cubic|decor|designer|desk|desktop|diamond|diaries|diary|dining|fabric|flat|folder|for|frame|frames|fridge|game|games|grain|hanging|heart|holder|hot|inch|journal|keychain|ladies|lamp|laptop|large|laser|leaf|light|lights|magnet|mat|menu|men|minimalistic|mirror|mirrors|mouse|mousepad|multicolor|multicolored|napkin|natural|notebook|office|organizer|pad|passport|pattern|patterned|pen|pencil|piece|placemat|placemats|plain|planner|plant|planter|planters|plants|pot|premium|print|ring|rings|roller|room|round|rubberized|runner|scanner|serving|set|shaped|sleeve|small|soil|square|stand|stationery|stool|striped|succulent|table|tablemat|tablemats|tabletop|tag|tags|tea|tealight|test|testtube|texture|textured|tissue|top|tote|travel|tray|trinket|triple|trivet|trivets|trophy|trophies|tube|ushaped|wall|wallet|with|women|workspace|yoga)/i;

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
    // Resend with no product keyword (e.g. "try again sending the image", typos) → use context
    const isImageResend = isResendRequest && /\b(picture|pictures|photo|photos|image|images)\b/i.test(userMessage);
    // v53.7 FIX: Added typo variants (calender, organiser, etc.) to prevent wrong context matching
    const genericImageRequest = (hasTrigger || isImageResend) && !/\b(coasters?|diar(y|ies)|bags?|wallets?|planters?|desk|organiz(er|ers)|organis(er|ers)|frames?|calend[ae]rs?|pens?|notebooks?|mats?|tables?|candles?|holders?|bottles?|trays?|test.?tubes?|mousepads?)\b/i.test(userMessage);

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

        // v56: Smart catalog routing — pick the right PDF based on keywords in the message.
        // Order matters: more specific categories first, generic last.
        if (/\b(trophy|trophies|award|awards|recognition|memento)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_TROPHY) {
          catalogUrl = CONFIG.PDF_CATALOG_TROPHY;
          catalogName = '9Cork-Trophy-Catalog.pdf';
          catalogCaption = 'Here is our cork trophy catalog! 🏆';
        }
        // v58: Tightened — match only yoga-specific phrases, not bare "mat" (which catches tablemat/dining mat)
        else if (/\byoga\b|\byoga ?mat\b|\byoga ?block\b|\byoga ?wheel\b|\byoga ?bolster\b/i.test(userMessage) && CONFIG.PDF_CATALOG_YOGA) {
          catalogUrl = CONFIG.PDF_CATALOG_YOGA;
          catalogName = '9Cork-Yoga-Catalog.pdf';
          catalogCaption = 'Here is our cork yoga essentials catalog! 🧘';
        }
        else if (/\b(planter|planters|plant|pot|pots|test tube)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_PLANTERS) {
          catalogUrl = CONFIG.PDF_CATALOG_PLANTERS;
          catalogName = '9Cork-Planters-Catalog.pdf';
          catalogCaption = 'Here is our cork planters catalog! 🌱';
        }
        else if (/\b(elevation|premium|executive|luxury)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_ELEVATION) {
          catalogUrl = CONFIG.PDF_CATALOG_ELEVATION;
          catalogName = '9Cork-Elevation-Catalog.pdf';
          catalogCaption = 'Here is our Elevation e-catalog (premium line)! ✨';
        }
        else if (/\b(minimal|minimalist|basic|simple|essential)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_MINIMALIST) {
          catalogUrl = CONFIG.PDF_CATALOG_MINIMALIST;
          catalogName = '9Cork-Minimalist-Catalog.pdf';
          catalogCaption = 'Here is our Minimalist e-catalog! 🌿';
        }
        else if (/\b(combo|combos|gifting combo|combo catalog)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_COMBOS) {
          catalogUrl = CONFIG.PDF_CATALOG_COMBOS;
          catalogName = '9Cork-Gifting-Combos-Catalog.pdf';
          catalogCaption = 'Here is our gifting combos catalog! 🎁';
        }
        // HORECA catalog detection (also covers caddy, bill folder, menu folder)
        else if (/\b(horeca|hotel|restaurant|cafe|bar|hospitality|caddy|bill folder|menu folder|room tag|qr scanner)\b/i.test(userMessage) && CONFIG.PDF_CATALOG_HORECA) {
          catalogUrl = CONFIG.PDF_CATALOG_HORECA;
          catalogName = '9Cork-HORECA-Catalog.pdf';
          catalogCaption = 'Here is our HORECA catalog for Hotels, Restaurants & Cafes! 🌿';
        }
        // General products catalog (default)
        else if (CONFIG.PDF_CATALOG_PRODUCTS) {
          catalogUrl = CONFIG.PDF_CATALOG_PRODUCTS;
          catalogName = '9Cork-Products-Catalog.pdf';
          catalogCaption = 'Here is our complete cork products catalog! 🌿';
        }
        // Fallback to legacy single catalog URL
        else if (CONFIG.PDF_CATALOG_URL) {
          catalogUrl = CONFIG.PDF_CATALOG_URL;
          catalogName = '9Cork-Catalog.pdf';
          catalogCaption = 'Here is our product catalog! 🌿';
        }

        if (catalogUrl) {
          console.log('📄 Sending catalog (' + catalogName + ') to', from);
        }

        if (catalogUrl) {
          // v55: Dedup — same catalog only once per 30 min
          const catalogType = catalogName.includes('HORECA') ? 'horeca'
            : catalogName.includes('Combos') ? 'combos'
            : 'products';
          if (!canSendCatalog(from, catalogType)) {
            console.log('📄 Catalog already sent recently, skipping (' + catalogType + ')');
            return;
          }
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
    // v60 — Single source of truth for category routing lives in
    // pricing/image-routing.js (CATEGORY_DEFINITIONS). One place to update
    // when adding/changing categories or marking new categories as having
    // images available.
    const resolvedCategory = hasTrigger ? resolveImageCategory(userMessage) : null;
    const catalogCategory = resolvedCategory ? resolvedCategory.code : null;

    if (catalogCategory) {
      // v53.24 FIX: When customer explicitly asks for images, clear sent tracker
      // This allows re-sending images when customer says "share images", "send pictures", etc.
      if (hasTrigger && /\b(share|send|show|give)\b/i.test(messageBody)) {
        console.log('🔄 Explicit image request detected, clearing sent tracker for fresh images');
        await sentImagesTracker.clear(from); // Clear sent history for this customer
      }

      // Intent-driven image selection (2026-07-06 spec): the same LLM-first
      // resolver that feeds pricing supplies the customer's product phrase +
      // refinements ("magnetic", "a5", "!yoga"). The old hardcoded size-only
      // filter (v53.15) is gone — sizes now arrive as refinements. Null intent
      // (LLM outage / no product mentioned) falls back to the category bucket,
      // which is the legacy behavior.
      let imageIntent = null;
      try {
        imageIntent = await resolveIntent(userMessage, conversationContext, { budgetMs: 3000 });
      } catch (e) {
        console.warn('⚠️ Image-path intent resolution failed (category fallback):', e.message);
      }
      const imageSearch = selectImageSearch(imageIntent, resolvedCategory);
      if (imageSearch) {
        console.log(`🖼️ Image search: term="${imageSearch.term}" refinements=[${imageSearch.refinements.join(', ')}] (${imageSearch.source})`);
      }

      // sentImagesTracker is managed per-URL via add/has/clear — no initialization needed

      // For 'all' category, pass 'all' string (triggers the variety code path
      // in findProductsByCategory). Otherwise the intent term (customer's own
      // phrase) beats the category bucket; bucket is the fallback.
      const mongoQueryTerm = (resolvedCategory && resolvedCategory.code === 'all')
        ? 'all'
        : (imageSearch ? imageSearch.term : (resolvedCategory ? resolvedCategory.mongoSearch : catalogCategory));

      // First try: Get new products excluding already sent
      let products = await findProductsByCategory(mongoQueryTerm, 10, from, true);

      // Narrow by refinements (same semantics as quote-engine narrowing:
      // a refinement matching nothing is ignored, so this can never produce
      // a false-empty result on its own).
      if (imageSearch && imageSearch.refinements.length > 0 && products.length > 0) {
        const originalCount = products.length;
        products = filterByRefinements(products, imageSearch.refinements);
        console.log(`🔍 Refinements [${imageSearch.refinements.join(', ')}] applied: ${originalCount} → ${products.length} products`);
      }

      // Intent term found nothing at all → retry once with the category
      // bucket, keeping refinements. Strictly no worse than the legacy path.
      if (products.length === 0 && imageSearch && imageSearch.source === 'intent'
          && resolvedCategory && resolvedCategory.mongoSearch && resolvedCategory.code !== 'all') {
        console.log(`🔍 Intent term "${imageSearch.term}" found nothing — falling back to category "${resolvedCategory.mongoSearch}"`);
        products = await findProductsByCategory(resolvedCategory.mongoSearch, 10, from, true);
        if (imageSearch.refinements.length > 0 && products.length > 0) {
          products = filterByRefinements(products, imageSearch.refinements);
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

        // v60 — image availability + PDF routing from pricing/image-routing.js.
        // If a category has no MongoDB images, route to:
        //   1. PDF catalog(s) — `pdfCatalogs` array (multiple) OR `pdfCatalog` (single, backward-compat)
        //   2. Else a category-specific fallback text message
        //   3. Else a generic fallback text message
        if (resolvedCategory && !resolvedCategory.hasImages) {
          console.log(`⚠️ Category '${catalogCategory}' has no MongoDB images`);

          // Normalize: support both `pdfCatalogs: [...]` (array) and `pdfCatalog: 'X'` (legacy single).
          const pdfList = resolvedCategory.pdfCatalogs
            || (resolvedCategory.pdfCatalog ? [resolvedCategory.pdfCatalog] : []);

          if (pdfList.length > 0) {
            // Send a brief caption FIRST (only once, even if multiple PDFs follow)
            try {
              if (resolvedCategory.pdfCaption) {
                await sendWhatsAppMessage(from, resolvedCategory.pdfCaption).catch(() => {});
              }
            } catch (e) { /* non-blocking */ }

            // Send each PDF in order
            let sentAny = false;
            for (const pdfKey of pdfList) {
              const envKey = `PDF_CATALOG_${pdfKey}`;
              const pdfUrl = CONFIG[envKey];
              if (!pdfUrl) {
                console.warn(`⚠️ ${envKey} env var not set — skipping PDF`);
                continue;
              }
              const filename = `9Cork-${pdfKey.charAt(0) + pdfKey.slice(1).toLowerCase()}-Catalog.pdf`;
              try {
                console.log(`📄 Sending ${envKey} catalog to ${from} for '${catalogCategory}'`);
                await sendWhatsAppDocument(from, pdfUrl, filename, '');  // empty caption — already sent above
                sentAny = true;
              } catch (err) {
                console.warn(`⚠️ PDF send failed (${envKey}):`, err.message);
              }
            }
            if (sentAny) return;
          }

          // Text fallback (when no PDFs configured OR all sends failed)
          const fallback = resolvedCategory.fallbackMessage ||
            "I don't have product photos handy for those right now — let me check with our team and share them shortly. The prices I quoted are accurate.";
          try {
            await sendWhatsAppMessage(from, fallback).catch(() => {});
          } catch (e) { /* non-blocking */ }
          return;
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
        if (CONFIG.PDF_CATALOG_HORECA && canSendCatalog(from, 'horeca')) {
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
        } else if (CONFIG.PDF_CATALOG_HORECA) {
          console.log('📄 HORECA catalog skipped (sent recently)');
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
        // v55: Dedup — only send once per 30 min per customer
        const horecaProducts = /\b(caddy|caddies|bar caddy|bill folder|bill folders|menu folder|menu folders|cork light|cork lights|trivets?|cork stool|cork stools)\b/i;
        if (horecaProducts.test(messageBody) && CONFIG.PDF_CATALOG_HORECA && canSendCatalog(from, 'horeca')) {
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

      // RAG: async-index this conversation (fire-and-forget — never blocks user response)
      if (CONFIG.RAG_ENABLED) {
        setImmediate(async () => {
          try {
            const result = await indexQAPair({
              customerPhone: from,
              customerMessage: messageBody,
              botResponse: agentResponse,
              timestamp: Date.now(),
              outcome: 'in_progress',
              conversationStage: 'live'
            });
            if (!result.success) {
              console.warn('⚠️ RAG index skipped/failed:', result.reason);
            }
          } catch (err) {
            console.warn('⚠️ Async indexing failed:', err.message);
          }
        });
      }

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

// Catalog send tracker — prevents the same catalog being sent twice within 30 minutes.
// Key: `${phone}:${catalogType}`, Value: timestamp of last send.
const catalogSendTracker = new Map();
const CATALOG_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function canSendCatalog(phone, catalogType) {
  const key = `${phone}:${catalogType}`;
  const lastSent = catalogSendTracker.get(key);
  if (lastSent && Date.now() - lastSent < CATALOG_COOLDOWN_MS) {
    return false;
  }
  catalogSendTracker.set(key, Date.now());
  return true;
}

// v57: Inbound message debouncer — batches rapid customer messages within DEBOUNCE_MS
// into a single processing pass. Prevents contradictory back-to-back responses.
// Key: phoneNumber. Value: { messages: [...], timerId, latestEnqueued: Date.now() }
const messageBuffer = new Map();
const DEBOUNCE_MS = 8000;  // 8s — captures typing gaps up to 7s (live test showed 5-6s gaps common)
const MAX_BATCH_SIZE = 10;

function bufferMessage(from, payload, processFn) {
  let entry = messageBuffer.get(from);
  if (!entry) {
    entry = { messages: [], timerId: null };
    messageBuffer.set(from, entry);
  }

  // Dedup: skip if this exact messageId is already buffered (Meta retry within debounce window)
  if (payload.messageId && entry.messages.some(m => m.messageId === payload.messageId)) {
    console.log(`🔄 Message ${payload.messageId} already buffered — skipping duplicate`);
    return;
  }

  entry.messages.push(payload);

  // Force flush if batch grows too large (prevents memory issues / runaway batches)
  if (entry.messages.length >= MAX_BATCH_SIZE) {
    if (entry.timerId) clearTimeout(entry.timerId);
    const batch = entry.messages.slice();
    messageBuffer.delete(from);
    processFn(batch).catch(err => console.error('❌ Batch processing failed (force-flush):', err.message));
    return;
  }

  // v60.1: If a previous batch is still processing for this phone (lock held),
  // extend the debounce timer instead of firing on schedule. This prevents
  // the "image takes 50s; 4 texts arrive; 4 separate replies fire" race.
  // The timer will re-check every DEBOUNCE_MS until the lock is free, then fire.
  if (entry.timerId) clearTimeout(entry.timerId);
  const fireWhenIdle = () => {
    if (phoneProcessingLock.has(from)) {
      // Still processing — defer another DEBOUNCE_MS and re-check
      console.log(`⏸ Debouncer: ${from} has lock held, deferring batch flush`);
      entry.timerId = setTimeout(fireWhenIdle, DEBOUNCE_MS);
      return;
    }
    const batch = entry.messages.slice();
    messageBuffer.delete(from);
    processFn(batch).catch(err => console.error('❌ Batch processing failed:', err.message));
  };
  entry.timerId = setTimeout(fireWhenIdle, DEBOUNCE_MS);
}

// Combine multiple message texts into one input for the AI
function combineMessages(batch) {
  if (batch.length === 1) return batch[0].messageBody;
  // Concatenate with " | " separator so the AI sees the customer's full intent
  return batch.map(m => m.messageBody).filter(Boolean).join(' | ');
}

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

  // v58: Clean up catalogSendTracker (was leaking — every customer:catalog pair kept forever)
  const catalogCleanupAge = 35 * 60 * 1000; // 35 min — slightly longer than CATALOG_COOLDOWN_MS so we don't drop a still-active cooldown
  for (const [key, ts] of catalogSendTracker.entries()) {
    if (now - ts > catalogCleanupAge) {
      catalogSendTracker.delete(key);
    }
  }
}, 5 * 60 * 1000);

function checkPhoneRateLimit(phoneNumber, messageContent = '') {
  const now = Date.now();
  const lastMessage = phoneRateLimits.get(phoneNumber) || 0;

  // v58: The 8s debouncer batches rapid messages into a single AI call. The rate limiter
  // is now only for genuine flood-attacks (>10 msgs in 1 second). Anything slower is
  // legitimate typing that the debouncer will merge.
  const minInterval = 100; // 100ms — only catches true bot/flood traffic

  if (now - lastMessage < minInterval) {
    const timeSinceLastMs = now - lastMessage;
    console.warn(`⚠️ Flood detected for ${phoneNumber} - ${timeSinceLastMs}ms since last message — dropping`);
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
      // v60: extract media ID for both image AND audio messages
      const mediaId = message.image?.id || message.audio?.id || message.video?.id;

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

      // Process text, image, AND audio (voice note) messages.
      // v60: audio added — transcribed via Groq Whisper inside processBatch.
      if ((messageType === 'text' && messageBody) || messageType === 'image' || messageType === 'audio') {
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

          // v57: Direct-path processor.
          // Accepts a BATCH of messages (one or more) and processes them as a single
          // unit so rapid customer follow-ups don't produce contradictory back-to-back replies.
          const processBatch = async (batch) => {
            const combinedMessageBody = combineMessages(batch);
            const batchMessageIds = batch.map(m => m.messageId).filter(Boolean);
            const latestMessageId = batchMessageIds[batchMessageIds.length - 1] || messageId;
            // Use the latest batch item's type/media (relevant for images; text batches won't differ)
            const lastItem = batch[batch.length - 1] || {};
            const batchMessageType = lastItem.messageType || messageType;
            const batchMediaId = lastItem.mediaId || mediaId;

            // Skip if all messages in the batch were already processed (Meta retry)
            if (batchMessageIds.length > 0 && batchMessageIds.every(id => sentResponses.has(id))) {
              console.log(`✅ All ${batchMessageIds.length} batched messages already processed — skipping`);
              return;
            }

            if (batch.length > 1) {
              console.log(`📦 Batched ${batch.length} messages from ${from}: "${combinedMessageBody.substring(0, 80)}..."`);
            }

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
                // v60 — Handle IMAGE messages with catalog-aware Gemini Vision.
                // PRIMARY identifier: Gemini 2.0 Flash (multimodal) with catalog
                //   knowledge — knows exactly which products we sell and refuses
                //   to misclassify (e.g. won't call a keychain "Casa Planter").
                // FALLBACK: legacy Smart Matcher if Gemini Vision is unavailable.
                if (batchMessageType === 'image' && batchMediaId) {
                  console.log('📸 Processing image with catalog-aware Gemini Vision...');
                  const customerCaption = (combinedMessageBody || '').trim();

                  // Download image (reusing vision handler's download method)
                  let imageData = null;
                  try {
                    imageData = await visionHandler.downloadImage(batchMediaId);
                  } catch (err) {
                    console.warn('⚠️ Image download failed:', err.message);
                  }

                  let identification = null;
                  if (imageData?.base64) {
                    try {
                      const imageBuffer = Buffer.from(imageData.base64, 'base64');
                      identification = await identifyProductFromImage(imageBuffer, imageData.mimeType || 'image/jpeg');
                      if (identification) {
                        console.log(`📸 Gemini Vision: "${identification.visibleObject}" (cork=${identification.isCorkProduct}, conf=${(identification.confidence * 100).toFixed(0)}%, category=${identification.matchedCategory || 'none'}, sku=${identification.matchedProductName || 'none'})`);
                      }
                    } catch (err) {
                      console.warn('⚠️ Gemini Vision failed, falling back to Smart Matcher:', err.message);
                    }
                  }

                  // ─── Decide what to do based on identification ───
                  if (identification && identification.isCorkProduct && identification.confidence >= 0.75) {
                    // HIGH confidence cork product — route through text pipeline
                    const productLabel = identification.matchedProductName || identification.matchedCategory || 'cork product';
                    const virtualText = customerCaption
                      ? `${customerCaption} (Customer also sent a photo — Gemini Vision identified it as: ${productLabel}, confidence ${(identification.confidence * 100).toFixed(0)}%. Confirm with customer before quoting.)`
                      : `Customer sent a photo of what appears to be a ${productLabel} (confidence ${(identification.confidence * 100).toFixed(0)}%). Confirm this is what they want, then ask quantity + customer type per RULE F.`;
                    console.log(`📸 → routing through text pipeline (high confidence cork match)`);
                    response = await processWithClaudeAgent(virtualText, from, context);
                  } else if (identification && identification.isCorkProduct && identification.confidence >= 0.5) {
                    // BORDERLINE cork product — ask for confirmation
                    const productLabel = identification.matchedProductName || identification.matchedCategory || 'cork product';
                    response = customerCaption
                      ? `Thanks for the photo! From what I can see this looks like a ${productLabel} — could you confirm? Once you do, I'll share the pricing.`
                      : `Thanks for the photo! This looks like it could be a ${productLabel}. Could you confirm and let me know how many pieces you need?`;
                    console.log(`📸 → asking customer to confirm (borderline cork match)`);
                  } else if (identification && identification.isCorkProduct === false) {
                    // Confidently NOT a cork product (e.g. keychain, leather wallet)
                    response = `Thanks for sharing the photo. From what I can see, this looks like a ${identification.visibleObject || 'product'} — that's outside our cork range. We specialize in cork-based products: coasters, diaries, planters, bags, frames, trays, holders, tablemats, trivets, gift boxes, yoga products, and more. Is there a cork product I can help you with?`;
                    console.log(`📸 → declining (non-cork item: ${identification.visibleObject})`);
                  } else if (identification && identification.confidence < 0.5) {
                    // Unclear image — ask for clarification
                    response = `Thanks for the photo! I couldn't quite tell what you're looking for — could you let me know which product you're interested in? (e.g., coasters, diaries, planters, frames, etc.)`;
                    console.log(`📸 → asking for clarification (low confidence: ${(identification.confidence * 100).toFixed(0)}%)`);
                  } else {
                    // Gemini Vision unavailable (network/API issue). No legacy
                    // matcher to fall back to — ask the customer to describe.
                    console.log(`📸 → Gemini Vision unavailable, asking customer to describe`);
                    response = `Thanks for the photo! I'm having trouble loading the image right now — could you tell me which product you're interested in? (e.g. coasters, diaries, planters, frames, etc.)`;
                  }

                  const logTag = identification
                    ? `vision: "${identification.visibleObject}" cork=${identification.isCorkProduct} conf=${(identification.confidence * 100).toFixed(0)}%`
                    : 'vision: unavailable';
                  await storeCustomerMessage(from, `[IMAGE: ${customerCaption || 'no caption'} — ${logTag}]`, latestMessageId).catch(err => console.warn('⚠️ storeCustomerMessage failed:', err.message));
                }
                // v60: Handle VOICE messages — transcribe with Groq Whisper, then process as normal text
                else if (batchMessageType === 'audio' && batchMediaId) {
                  console.log('🎤 Processing voice message with Groq Whisper...');
                  const transcribedText = await handleVoiceMessage(batchMediaId, CONFIG.WHATSAPP_TOKEN);
                  if (!transcribedText) {
                    response = "I couldn't quite catch that voice note — could you type your message or try recording again?";
                    await storeCustomerMessage(from, '[VOICE: transcription failed]', latestMessageId).catch(() => {});
                  } else {
                    // Process the transcribed text through the normal flow — quote engine,
                    // RAG, LLM, sanitizer, everything works the same.
                    response = await processWithClaudeAgent(transcribedText, from, context);
                    await storeCustomerMessage(from, `[VOICE]: ${transcribedText}`, latestMessageId).catch(err => console.warn('⚠️ storeCustomerMessage failed:', err.message));
                  }
                } else {
                  // Handle TEXT messages — use combined message (processWithClaudeAgent already sanitizes)
                  response = await processWithClaudeAgent(combinedMessageBody, from, context);
                  await storeCustomerMessage(from, combinedMessageBody, latestMessageId).catch(err => console.warn('⚠️ storeCustomerMessage failed:', err.message));

                  // Auto-send HORECA catalog (dedup — once per 30 min per customer)
                  const horecaProducts = /\b(caddy|caddies|bar caddy|bill folder|bill folders|menu folder|menu folders|cork light|cork lights|trivets?|cork stool|cork stools)\b/i;
                  if (horecaProducts.test(combinedMessageBody) && CONFIG.PDF_CATALOG_HORECA && canSendCatalog(from, 'horeca')) {
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

                // Mark ALL batched messageIds as sent so future retries get deduped
                for (const id of batchMessageIds) {
                  sentResponses.set(id, {
                    timestamp: new Date(),
                    responseText: response.substring(0, 100),
                    phoneNumber: from
                  });
                }

                // RAG: async-index this conversation
                if (CONFIG.RAG_ENABLED) {
                  setImmediate(async () => {
                    try {
                      const result = await indexQAPair({
                        customerPhone: from,
                        customerMessage: combinedMessageBody || '[IMAGE]',
                        botResponse: response,
                        timestamp: Date.now(),
                        outcome: 'in_progress',
                        conversationStage: 'live'
                      });
                      if (!result.success) {
                        console.warn('⚠️ RAG index skipped/failed:', result.reason);
                      }
                    } catch (err) {
                      console.warn('⚠️ Async indexing failed:', err.message);
                    }
                  });
                }

                // Bigin CRM: push lead/deal events (fire-and-forget)
                if (biginConfigured()) {
                  setImmediate(() => {
                    syncBiginFromConversation(from, combinedMessageBody, response, context)
                      .catch(err => console.warn('⚠️ Bigin sync failed:', err.message));
                  });
                }

                await handleImageDetectionAndSending(from, response, combinedMessageBody, context);
                await storeAgentMessage(from, response).catch(err => console.warn('⚠️ storeAgentMessage failed:', err.message));

              } catch (err) {
                console.error('Error processing message:', err);
                if (CONFIG.SENTRY_DSN) Sentry.captureException(err);
                await sendWhatsAppMessage(
                  from,
                  "Sorry, I'm experiencing technical difficulties. Please try again in a moment."
                ).catch(e => console.error('Failed to send error message:', e));
              }
            }); // end withPhoneLock
          };

          // v60.1: Route the message:
          //  - Images/audio: drain any pending text buffer FIRST (combine
          //    text + media into one batch), then process immediately.
          //  - Text-only: debounce (8s) so rapid follow-ups get batched.
          // Note: withPhoneLock already serializes processing per-phone, so
          // subsequent texts that arrive WHILE this image processes will
          // queue up behind it (waiting for the lock) and get batched then.
          const payload = { messageBody, messageId, messageType, mediaId };
          if (messageType === 'image' || messageType === 'audio') {
            const pendingEntry = messageBuffer.get(from);
            let combinedBatch = [payload];
            if (pendingEntry && pendingEntry.messages.length > 0) {
              if (pendingEntry.timerId) clearTimeout(pendingEntry.timerId);
              combinedBatch = [...pendingEntry.messages, payload];
              messageBuffer.delete(from);
              console.log(`📦 Drained ${pendingEntry.messages.length} buffered text msg(s) into image/audio batch`);
            }
            await processBatch(combinedBatch);
          } else {
            bufferMessage(from, payload, processBatch);
          }
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
      // v60: extract media ID for image, audio, and video messages
      const mediaId = message.image?.id || message.audio?.id || message.video?.id;

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

      // Process with optimized bot (text, image, audio)
      if ((messageType === 'text' && messageBody) || messageType === 'image' || messageType === 'audio') {
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

// Build context-aware message with known facts to prevent repeated questions.
// CRITICAL: Current message FACTS override history. If customer changes product/qty,
// history is reset for that field. Greeting → new product = full session reset.
function buildContextAwareMessage(userMessage, conversationHistory) {
  const recentHistory = conversationHistory.slice(-6);

  const TOPIC_CHANGE = /\b(no longer|not needed|cancel|don't need|instead|switch to|different|fresh chat|new chat|start over|start fresh|from scratch|not required|forget|ignore)\b/i;
  const GREETING = /^\s*(hi|hello|hey|namaste|hi there|good morning|good evening)\b/i;
  const PRODUCT_RE = /\b(coasters?|diary|diaries|planters?|organizers?|calend[ae]rs?|bags?|wallets?|frames?|photo frames?|trays?|combos?|bottles?|clocks?|lamps?|pens?|metal pens?|tea ?lights?|candles?|trophy|trophies|yoga|mats?|sleeves?|caddy|caddies|holders?|cases?)\b/i;

  // Find the most recent topic change OR greeting+product (implicit session restart)
  let startIdx = 0;
  for (let i = 0; i < recentHistory.length; i++) {
    if (recentHistory[i].role !== 'user') continue;
    const text = recentHistory[i].content;
    if (TOPIC_CHANGE.test(text)) {
      startIdx = i + 1;
    }
    // Implicit reset: a SHORT greeting message resets context (e.g. "hi", "hello").
    // Longer messages starting with "Hi" (like "Hi I need diaries continued from yesterday")
    // should NOT trigger a reset — they're continuing the conversation.
    if (GREETING.test(text) && text.length <= 25) {
      startIdx = i;  // include this greeting message as the start of the new session
    }
  }

  // The CURRENT message is the authoritative source for facts. History is fallback only.
  const currentMessage = userMessage;
  const historyMessages = recentHistory.slice(startIdx).filter(m => m.role === 'user');
  // Exclude the current message from history if it ended up included
  const historyText = historyMessages
    .filter(m => m.content !== currentMessage)
    .map(m => m.content)
    .join(' ')
    .toLowerCase();

  // CURRENT-MESSAGE-FIRST extraction helpers
  const matchCurrentThenHistory = (regex) => {
    const cur = currentMessage.match(regex);
    if (cur) return cur;
    return historyText.match(regex);
  };

  const facts = [];

  // PRODUCT — prefer current message's product mention over history
  const productMatch = matchCurrentThenHistory(PRODUCT_RE);
  if (productMatch) facts.push(`PRODUCT: ${productMatch[0]}`);

  // QUANTITY — prefer current message's qty over history (fixes "300 leak from prior chat")
  const qtyMatch = matchCurrentThenHistory(/(\d+)\s*(?:pcs|pieces|nos|people|units|qty|quantity|numbers?)/i);
  if (qtyMatch) facts.push(`QUANTITY: ${qtyMatch[1]}`);
  // Also catch bare numbers when current message has a product mention (e.g. "i need pens, 500")
  if (!qtyMatch) {
    const bareCur = currentMessage.match(/\b(\d{2,5})\b/);
    if (bareCur && productMatch && currentMessage.match(PRODUCT_RE)) {
      facts.push(`QUANTITY: ${bareCur[1]}`);
    }
  }

  // BUDGET — prefer current
  const budgetMatch = matchCurrentThenHistory(/(?:₹|rs\.?|inr)\s*(\d[\d,]*)/i);
  if (budgetMatch) facts.push(`BUDGET: ₹${budgetMatch[1]}`);

  // USE CASE — prefer current
  const useCaseRe = /(?:for|gift.*?for|occasion.*?is|it'?s?\s+(?:for|a))\s+([^.!?\n]{3,40})/i;
  let useCaseMatch = currentMessage.match(useCaseRe);
  if (!useCaseMatch && /gift|gifting|event|occasion|corporate|wedding|birthday|anniversary|diwali|christmas/.test(historyText)) {
    useCaseMatch = historyText.match(useCaseRe);
  }
  if (useCaseMatch) facts.push(`USE CASE: ${useCaseMatch[1].trim()}`);

  // TIMELINE — prefer current
  const timelineMatch = matchCurrentThenHistory(/\b(next week|this month|urgent|asap|year.?end|quarter|diwali|christmas|by \w+)\b/i);
  if (timelineMatch) facts.push(`TIMELINE: ${timelineMatch[0]}`);

  if (facts.length > 0) {
    console.log(`📋 Context facts (start@${startIdx}/${recentHistory.length}): ${facts.join(', ')}`);
    return `[ALREADY KNOWN: ${facts.join(', ')}]\n\n${userMessage}`;
  }
  return userMessage;
}

// Process message with Multi-Provider AI agent (Groq → Gemini → Rules)
// Bigin CRM sync — triggered at TWO moments only:
//
// 1. PI sent → bot's response contains payment/PI markers (bank details, "payment details",
//    "proforma", "invoice"). Creates Deal in "Qualification" / "Negotiation" stage.
//    Indicates customer is past qualification and has shared invoice details.
//
// 2. Sale confirmed → outcome detector flags 'sale' (customer said "paid"/"transferred").
//    Updates the open deal to "Closed Won". Creates one if none exists yet.
//
// Everything else (greetings, quotes, abandons) is ignored to keep CRM clean.
async function syncBiginFromConversation(phone, customerMsg, botResponse, context) {
  // Build conversation array for outcome detection
  const allMessages = [
    ...context.map(m => ({
      role: m.role === 'user' ? 'customer' : 'agent',
      content: m.content,
      timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now()
    })),
    { role: 'customer', content: customerMsg, timestamp: Date.now() - 1000 },
    { role: 'agent', content: botResponse, timestamp: Date.now() }
  ];

  // v61 Phase B.3 — PRIMARY trigger source is the conversation state machine.
  // State transitions are derived from accumulated facts, more reliable than
  // keyword detection alone. Keyword detection is kept as a redundant safety net.
  let stateBasedTrigger = null;
  try {
    const stateForBigin = deriveConversationState(allMessages, null);
    if (stateForBigin?.code === 'POST_SALE') {
      stateBasedTrigger = 'sale';
    } else if (stateForBigin?.code === 'COLLECTING_INVOICE_INFO' || stateForBigin?.code === 'AWAITING_PAYMENT') {
      stateBasedTrigger = 'pi_sent';
    }
  } catch (e) { /* fall through to keyword detection */ }

  // Legacy keyword-based detection (kept as safety net)
  const outcome = detectOutcome(allMessages);
  const isSaleByKeyword = outcome.outcome === 'sale' && outcome.confidence >= 0.8;

  const customerLatest = (customerMsg || '').toLowerCase();
  const recentCustomerOnly = allMessages
    .filter(m => m.role === 'customer')
    .slice(-5)
    .map(m => m.content)
    .join(' ')
    .toLowerCase();

  const INTENT_KEYWORDS = /\b(send (the )?(invoice|pi|proforma|bill|quote)|share (the )?(payment|bank|account|invoice|pi) details|how (do|to) (i|we) pay|payment method|send (the )?qr|share (the )?qr|bank details|account details)\b/i;
  const GSTIN_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]Z[A-Z\d]\b/i;
  const hasIntent = INTENT_KEYWORDS.test(customerLatest) || INTENT_KEYWORDS.test(recentCustomerOnly);
  const hasGSTIN = GSTIN_PATTERN.test(recentCustomerOnly);
  const PI_MARKERS = /(canara bank|cnrb0007617|120032289098|share the payment screenshot)/i;
  const botSentPI = PI_MARKERS.test(botResponse);
  const isPISentByKeyword = hasIntent || hasGSTIN || botSentPI;

  // Final decision: state machine wins if it has a verdict; otherwise fall to keyword
  const isSale = stateBasedTrigger === 'sale' || isSaleByKeyword;
  const isPISent = stateBasedTrigger === 'pi_sent' || isPISentByKeyword;

  if (!isSale && !isPISent) return;

  const eventType = isSale ? 'sale' : 'pi_sent';
  console.log(`📊 Bigin trigger reason: ${stateBasedTrigger ? 'state-machine[' + stateBasedTrigger + ']' : ''}${!stateBasedTrigger && hasIntent ? 'customer-intent-keyword ' : ''}${!stateBasedTrigger && hasGSTIN ? 'customer-shared-GSTIN ' : ''}${!stateBasedTrigger && botSentPI ? 'bot-sent-bank-details ' : ''}${!stateBasedTrigger && isSaleByKeyword ? 'outcome-detector-sale' : ''}`.trim());

  // Extract products mentioned in last 10 customer messages
  const recentCustomerText = allMessages
    .filter(m => m.role === 'customer')
    .slice(-10)
    .map(m => m.content)
    .join(' ');
  const PRODUCT_RE = /\b(coasters?|diary|diaries|planters?|trays?|combos?|pens?|trophy|trophies|yoga ?mats?|caddy|caddies|wallets?|bags?|frames?|holders?|cases?|calendars?|organizers?)\b/gi;
  const products = [...new Set((recentCustomerText.match(PRODUCT_RE) || []).map(p => p.toLowerCase()))];

  // Extract amount: prefer outcome saleAmount, else max ₹ value mentioned
  let amount = outcome.saleAmount || 0;
  if (!amount) {
    const allText = allMessages.map(m => m.content).join(' ');
    const amounts = [...allText.matchAll(/₹\s*([\d,]{3,})/g)].map(m => parseInt(m[1].replace(/,/g, '')));
    amount = amounts.length ? Math.max(...amounts) : 0;
  }

  // Extract company name if customer shared it (look for ALL CAPS or "Pvt Ltd" style)
  let company = null;
  const companyMatch = recentCustomerText.match(/\b([A-Z][A-Za-z0-9& ]{2,40}(?:\s+(?:Pvt|Private|Ltd|Limited|LLP|Industries|Enterprises|Co\.?)))\b/);
  if (companyMatch) company = companyMatch[1].trim();

  const productLabel = products.slice(0, 2).join(', ') || 'order';
  const dealName = isSale
    ? `Sale — ${company || phone} — ${productLabel}`
    : `PI Sent — ${company || phone} — ${productLabel}`;

  const lastFew = allMessages.slice(-8).map(m => `${m.role}: ${m.content.substring(0, 200)}`).join('\n');
  const notes = `Triggered by: ${eventType}\n${company ? 'Company: ' + company + '\n' : ''}\nRecent exchange:\n${lastFew}`;

  const result = await pushBiginEvent({
    type: eventType,
    phone,
    name: company,
    amount,
    products,
    dealName,
    notes
  });

  if (result.success) {
    console.log(`📊 Bigin ${eventType} synced (${result.action})${result.dealId ? ' deal=' + result.dealId : ''}`);
  } else {
    console.warn(`⚠️ Bigin ${eventType} push failed: ${result.reason}`);
  }
}

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

    // v60 — Path B: deterministic pricing. Before calling the LLM, see if this
    // turn carries a pricing intent. If so, run the intent extractor + quote
    // engine and inject a [VERIFIED QUOTE] block into the message the LLM
    // sees. The LLM's job becomes "present this exact quote conversationally",
    // not "compute the price". Eliminates the whole class of hallucination bugs.
    let augmentedMessage = contextAwareMessage;
    // Declared OUTSIDE the engine try-block so post-LLM code can reference
    // them (state enforcer + StateLog telemetry). Previously these were
    // declared inside, causing a ReferenceError at line 2892 when the
    // try-block scope ended.
    let intent = null;
    let derivedState = null;
    // Hoisted so the post-LLM outbound numeric guard can validate reply ₹
    // amounts against this turn's engine quote (2026-07-06 incident).
    let verifiedQuote = null;
    try {
      // ONE LLM pass per turn extracts the full intent (product, refinements,
      // quantity, customer type, branding). Regex fallback + telemetry flag
      // live inside the resolver. 3s wall-clock budget on the interactive path.
      intent = await resolveIntent(sanitizedMessage, context, { budgetMs: 3000 });

      // v61 Phase B.1: derive conversation state and inject the state guard.
      // Customer type arrives on the intent from the LLM-first resolver above.
      try {
        const fullContext = [...context, { role: 'customer', content: sanitizedMessage }];
        derivedState = await deriveStateAsync(fullContext, intent, sanitizedPhone);

        if (derivedState && derivedState.code !== 'GREETING' && derivedState.code !== 'POST_SALE') {
          const stateBlock = `[CONVERSATION STATE: ${derivedState.code}]\nGuidance: ${derivedState.guard}`;
          augmentedMessage = `${augmentedMessage}\n\n${stateBlock}`;
          console.log(`🎯 State: ${derivedState.code} — ${derivedState.reason}`);
        }
      } catch (stateErr) {
        console.warn('⚠️ State derivation failed (continuing without):', stateErr.message);
      }

      if (intent) {
        // Confidence gate (llm source only): below 0.6 the extraction is too
        // uncertain to quote from — ask a clarifying question instead. The
        // extraction still flowed into state derivation above, so the next
        // turn benefits. Regex fallback carries confidence 1.0 by design.
        if (intent.source === 'llm' && intent.confidence < 0.6) {
          const block = [
            '[PRICING — UNCERTAIN INTENT]:',
            'The customer may want a quote but their request is unclear.',
            'Ask ONE friendly clarifying question about what they need. Do NOT quote any price yet.'
          ].join('\n');
          // Append (don't rebuild from contextAwareMessage) so the
          // [CONVERSATION STATE] guidance block appended above survives.
          augmentedMessage = `${augmentedMessage}\n\n${block}`;
          console.log(`💰 Low-confidence intent (${intent.confidence}) — asking instead of quoting`);
        } else if (intent.productQuery && intent.quantity && intent.customerType) {
          const quote = computeQuote(intent);
          if (quote.found) {
            verifiedQuote = quote;
            const customerLine = formatQuoteForCustomer(quote);

            // State-aware injection (2026-07-06 incident): if this exact quote
            // was already presented (state QUOTE_PRESENTED and the grand total
            // appears in the bot's last quoted message), the customer is now
            // deciding or objecting — commanding "present THIS EXACT SENTENCE"
            // again makes the bot parrot the quote at an objecting customer.
            // A CHANGED quote (new qty/product → different total) still
            // presents fresh.
            const lastBotQuoteMsg = [...context].reverse().find(
              m => m.role !== 'user' && m.role !== 'customer' && /₹\s*[\d,]+/.test(m.content || '')
            );
            const alreadyPresented = derivedState?.code === 'QUOTE_PRESENTED'
              && lastBotQuoteMsg
              && extractRupeeAmounts(lastBotQuoteMsg.content).includes(quote.grandTotal);

            if (alreadyPresented) {
              const block = [
                '[QUOTE ALREADY PRESENTED — the customer is deciding or objecting]:',
                `Active verified quote (for reference): ${customerLine}`,
                '',
                'Do NOT re-pitch the full quote unprompted. Respond to what the customer actually said.',
                'If they object to the price: empathize, hold the price, and offer to check with the team for large orders — NEVER invent a discount or alter any number.',
                'Any number you mention must come EXACTLY from the verified quote above.'
              ].join('\n');
              augmentedMessage = `${augmentedMessage}\n\n${block}`;
              console.log(`💰 Quote already presented (₹${quote.grandTotal}) — objection/decision guidance injected`);
            } else {
              // v61 Single-Brain: inject the PREBUILT customer-facing sentence,
              // not structured data the LLM has to assemble. LLM's only job is
              // to wrap it in a warm conversational tone, never recalculate.
              const block = [
                '[VERIFIED QUOTE — present THIS EXACT SENTENCE to the customer, in your own warm tone]:',
                customerLine,
                '',
                'You may rephrase slightly for warmth but the numbers (₹ amounts) and the product name must be EXACTLY as written above.',
                'Do NOT mention MRP, discount %, slab tier, or any internal math.'
              ].join('\n');
              augmentedMessage = `${augmentedMessage}\n\n${block}`;
              console.log(`💰 Verified quote injected: ${quote.product.name} × ${quote.quantity} = ₹${quote.grandTotal}`);
            }
          } else if (quote.error === 'multiple_matches' && quote.matches?.length) {
            // Refinements were already applied inside the engine; whatever is
            // still ambiguous needs a human choice. Names only — engine knows
            // MRPs, the LLM doesn't need to.
            const block = [
              '[PRODUCT AMBIGUOUS — ask the customer which specific product they want]:',
              'Catalog matches for their query:',
              ...quote.matches.slice(0, 6).map(m => `- ${m.name}`),
              'Do NOT quote a price yet. Ask the customer to choose one of the above options.'
            ].join('\n');
            // Append (don't rebuild from contextAwareMessage) so the
          // [CONVERSATION STATE] guidance block appended above survives.
          augmentedMessage = `${augmentedMessage}\n\n${block}`;
            console.log(`💰 Product ambiguous for "${intent.productQuery}" — ${quote.matches.length} matches after refinements`);
          } else if (quote.error === 'product_not_found') {
            const block = [
              '[NO CATALOG MATCH — do NOT invent a price]:',
              `Customer mentioned "${intent.productQuery}" but no matching product exists in the catalog.`,
              'Either ask a clarifying question OR escalate per RULE G — never fabricate a price.'
            ].join('\n');
            // Append (don't rebuild from contextAwareMessage) so the
          // [CONVERSATION STATE] guidance block appended above survives.
          augmentedMessage = `${augmentedMessage}\n\n${block}`;
            console.log(`💰 No catalog match for "${intent.productQuery}"`);
          } else if (quote.error === 'branding_not_allowed_for_product') {
            const block = [
              '[BRANDING RESTRICTION]:',
              `Customer wants "${quote.requestedBranding}" on "${quote.product}".`,
              `Allowed branding techniques for this product: ${quote.allowedBranding.join(', ')}.`,
              'Politely redirect to an allowed technique.'
            ].join('\n');
            // Append (don't rebuild from contextAwareMessage) so the
          // [CONVERSATION STATE] guidance block appended above survives.
          augmentedMessage = `${augmentedMessage}\n\n${block}`;
            console.log(`💰 Branding restriction: ${quote.requestedBranding} not allowed for ${quote.product}`);
          }
        } else if (intent.productQuery || intent.quantity) {
          // Pricing intent detected but missing required field(s). Tell the LLM what's missing.
          const missing = [];
          if (!intent.productQuery) missing.push('which product');
          if (!intent.quantity) missing.push('how many pieces');
          if (!intent.customerType) missing.push('end-consumer or reseller (RULE F)');
          const block = `[PRICING — MISSING INFO]: Ask the customer for: ${missing.join(', ')}. Do not quote a price yet.`;
          // Append (don't rebuild from contextAwareMessage) so the
          // [CONVERSATION STATE] guidance block appended above survives.
          augmentedMessage = `${augmentedMessage}\n\n${block}`;
        }
      }
    } catch (engineErr) {
      console.warn('⚠️ Quote engine error (continuing without verified quote):', engineErr.message);
    }

    // Use multi-provider AI manager with automatic failover
    // Send last 50 messages for context (kept at 50 per user preference — accept TPM trade-off)
    // v54.3: Use context-aware message (with [ALREADY KNOWN: ...] prefix) as the current message
    const contextWithFacts = [...context, { role: 'user', content: augmentedMessage }];
    const result = await aiManager.getResponse(
      systemPrompt, // v53.20: Now dynamic based on previous conversation!
      contextWithFacts.slice(-50), // Last 50 messages (including new message with facts)
      augmentedMessage,
      sanitizedPhone,  // Pass userId for cache isolation (prevents cross-user cache contamination)
      ragContext  // RAG-augmented context (empty string if RAG_ENABLED=false)
    );

    // v59 — sanitize the LLM output before BOTH cache + return so customer
    // never sees paise and stored context can never re-train the bot on decimals
    const sanitized = sanitizeBotReply(result.response);

    // v61 Phase B.2 — state enforcer: validate the LLM's reply against the
    // current conversation state. If the LLM tried to do something disallowed
    // (quote during AWAITING_CUSTOMER_TYPE, ask for invoice during GREETING,
    // expose discount %, list products with prices during disambiguation, etc.),
    // the enforcer either strips the offending phrase or substitutes a
    // state-appropriate canned reply.
    let cleaned = sanitized;
    let enforcerAction = 'no_action';
    let enforcerReason = null;
    let enforcerViolations = [];
    if (derivedState) {
      // Outbound numeric guard rides along: reply ₹ amounts are validated
      // against this turn's engine quote (fabricated numbers get repaired).
      const enforcement = enforceState(derivedState, sanitized, { quote: verifiedQuote });
      if (!enforcement.allowed) {
        console.warn(`🚦 State enforcer OVERRIDE [${derivedState.code}]: ${enforcement.reason}`);
        console.warn(`   Original: "${enforcement.originalReply?.substring(0, 100)}"`);
        console.warn(`   Replaced: "${enforcement.reply.substring(0, 100)}"`);
        cleaned = enforcement.reply;
        enforcerAction = 'override';
        enforcerReason = enforcement.reason;
        enforcerViolations = enforcement.reason ? enforcement.reason.split(', ') : [];
      } else if (enforcement.stripped) {
        console.warn(`🚦 State enforcer STRIPPED [${derivedState.code}]: ${enforcement.reason}`);
        cleaned = enforcement.reply;
        enforcerAction = 'strip';
        enforcerReason = enforcement.reason;
      } else {
        enforcerAction = 'pass';
      }
    }

    console.log(`✅ Response from ${result.provider.toUpperCase()}: ${cleaned.substring(0, 100)}...`);

    // v61 Phase B.3 — telemetry: log state + enforcer action to StateLog
    // (fire-and-forget so logging never blocks the customer reply)
    if (derivedState) {
      setImmediate(async () => {
        try {
          await StateLog.create({
            customerPhone: sanitizedPhone,
            stateCode: derivedState.code,
            stateReason: derivedState.reason,
            enforcerAction,
            enforcerReason,
            enforcerViolations,
            productQuery: intent?.productQuery || null,
            quantity: intent?.quantity || null,
            customerType: intent?.customerType || null,
            hadVerifiedQuote: augmentedMessage.includes('[VERIFIED QUOTE'),
            customerMessage: sanitizedMessage.substring(0, 100),
            llmReplyBefore: result.response.substring(0, 150),
            finalReply: cleaned.substring(0, 150)
          });
        } catch (err) {
          // Logging failure should NEVER affect the reply path
          console.warn('⚠️ StateLog write failed (non-blocking):', err.message);
        }
      });
    }

    // v59 — RULE G escalation tagging (fire-and-forget so it never blocks reply)
    if (isEscalation(cleaned)) {
      console.log(`📌 RULE G escalation detected for ${sanitizedPhone}`);
      setImmediate(async () => {
        try {
          await Conversation.findOneAndUpdate(
            { customerPhone: sanitizedPhone, status: 'active' },
            {
              $set: { 'metadata.needsHumanFollowup': true },
              $push: {
                'metadata.escalations': {
                  timestamp: new Date(),
                  customerMessage: sanitizedMessage,
                  botResponse: cleaned.substring(0, 250),
                  resolved: false
                }
              }
            },
            { upsert: false }
          );
        } catch (err) {
          console.warn('⚠️ Escalation tagging failed:', err.message);
        }
      });
    }

    // Store AI response in in-memory cache (use cleaned version — breaks feedback loop)
    customerMemory.push({
      role: 'assistant',
      content: cleaned,
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

    return cleaned;

  } catch (error) {
    // Log the full error with stack so we can diagnose root causes from Render logs.
    // Previously this only logged `error.message` which made it impossible to know
    // which line/function threw — hiding the root cause behind the friendly message.
    console.error('❌ Error in AI processing:');
    console.error('   message:', error?.message);
    console.error('   name:', error?.name);
    console.error('   stack:', error?.stack);
    console.error('   customerPhone:', customerPhone);
    console.error('   message snippet:', (message || '').substring(0, 200));
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

// RAG monitoring endpoint — conversation counts, conversion rate, recent failures
app.get('/rag-stats', monitoringLimiter, async (req, res) => {
  try {
    const RagFailure = require('./models/RagFailure');

    const [total, sales, embedded, recentFailures] = await Promise.all([
      Conversation.countDocuments({}),
      Conversation.countDocuments({ outcome: 'sale' }),
      Conversation.countDocuments({ embedded: true }),
      RagFailure.find({ timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean()
    ]);

    res.json({
      status: 'ok',
      ragEnabled: CONFIG.RAG_ENABLED,
      conversations: { total, sales, embedded },
      conversionRate: total > 0 ? ((sales / total) * 100).toFixed(1) + '%' : 'N/A',
      recentFailures: recentFailures.length,
      failures: recentFailures.slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      queueAvailable: !!messageQueue,
      // LLM-first intent extraction telemetry: a rising regexFallback:llm
      // ratio means Groq trouble (see 2026-07-05 spec, rollout section).
      intentResolver: getResolverStats()
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

// v61 Phase B.3 — State Dashboard
// JSON: GET /admin/state-dashboard.json  (consumed by HTML page or scripts)
// HTML: GET /admin/state-dashboard       (human-friendly view)
app.get('/admin/state-dashboard.json', monitoringLimiter, async (req, res) => {
  try {
    const sinceHours = parseInt(req.query.hours, 10) || 24;
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    // Distribution: how many conversations in each state in the lookback window
    const stateCounts = await StateLog.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: { _id: '$stateCode', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Enforcer activity: how often each action fires
    const enforcerCounts = await StateLog.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: { _id: '$enforcerAction', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Most-fired violations (when enforcer overrides/strips)
    const violationCounts = await StateLog.aggregate([
      { $match: { timestamp: { $gte: since }, enforcerAction: { $in: ['override', 'strip'] } } },
      { $unwind: '$enforcerViolations' },
      { $group: { _id: '$enforcerViolations', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Recent unique conversations (last 20 phones to interact)
    const recentPhones = await StateLog.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $sort: { timestamp: -1 } },
      { $group: {
          _id: '$customerPhone',
          lastSeen: { $first: '$timestamp' },
          currentState: { $first: '$stateCode' },
          turnCount: { $sum: 1 },
          overrideCount: { $sum: { $cond: [{ $eq: ['$enforcerAction', 'override'] }, 1, 0] } }
      } },
      { $sort: { lastSeen: -1 } },
      { $limit: 20 }
    ]);

    res.json({
      windowHours: sinceHours,
      generatedAt: new Date().toISOString(),
      stateCounts,
      enforcerCounts,
      topViolations: violationCounts,
      recentPhones
    });
  } catch (err) {
    console.error('State dashboard JSON error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/state-dashboard', monitoringLimiter, async (req, res) => {
  try {
    const sinceHours = parseInt(req.query.hours, 10) || 24;
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const [stateCounts, enforcerCounts, violationCounts, recentPhones] = await Promise.all([
      StateLog.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: '$stateCode', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      StateLog.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: '$enforcerAction', count: { $sum: 1 } } }
      ]),
      StateLog.aggregate([
        { $match: { timestamp: { $gte: since }, enforcerAction: { $in: ['override', 'strip'] } } },
        { $unwind: '$enforcerViolations' },
        { $group: { _id: '$enforcerViolations', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      StateLog.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $sort: { timestamp: -1 } },
        { $group: {
            _id: '$customerPhone',
            lastSeen: { $first: '$timestamp' },
            currentState: { $first: '$stateCode' },
            turnCount: { $sum: 1 },
            overrideCount: { $sum: { $cond: [{ $eq: ['$enforcerAction', 'override'] }, 1, 0] } }
        } },
        { $sort: { lastSeen: -1 } },
        { $limit: 20 }
      ])
    ]);

    const totalLogs = stateCounts.reduce((s, c) => s + c.count, 0);

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>9 Cork Bot — State Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 24px; background: #f5f5f7; color: #1d1d1f; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .subtitle { color: #6e6e73; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .card h2 { font-size: 16px; margin: 0 0 12px; color: #1d1d1f; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 8px 0; border-bottom: 1px solid #e5e5e7; color: #6e6e73; font-weight: 500; }
    td { padding: 8px 0; border-bottom: 1px solid #f5f5f7; }
    .bar { background: #007aff; height: 8px; border-radius: 4px; }
    .bar-bg { background: #e5e5e7; border-radius: 4px; overflow: hidden; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .pill-pass { background: #d1f4d4; color: #137333; }
    .pill-strip { background: #fff4d6; color: #8c6d00; }
    .pill-override { background: #ffd6d6; color: #b00020; }
    .pill-no_action { background: #e5e5e7; color: #6e6e73; }
    .controls { margin-bottom: 24px; }
    .controls a { display: inline-block; padding: 6px 12px; border-radius: 6px; background: white; color: #007aff; text-decoration: none; margin-right: 8px; font-size: 14px; }
    .controls a.active { background: #007aff; color: white; }
    .empty { color: #6e6e73; font-style: italic; padding: 12px 0; }
  </style>
</head>
<body>
  <h1>🤖 State Dashboard — 9 Cork Bot</h1>
  <div class="subtitle">Last ${sinceHours}h • ${totalLogs} total state events • Generated ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>

  <div class="controls">
    <a href="?hours=1" class="${sinceHours === 1 ? 'active' : ''}">Last hour</a>
    <a href="?hours=24" class="${sinceHours === 24 ? 'active' : ''}">Last 24h</a>
    <a href="?hours=168" class="${sinceHours === 168 ? 'active' : ''}">Last week</a>
    <a href="/admin/state-dashboard.json?hours=${sinceHours}">JSON</a>
  </div>

  <div class="grid">
    <div class="card">
      <h2>🎯 Conversation states</h2>
      ${stateCounts.length === 0 ? '<div class="empty">No state events yet.</div>' : `
      <table>
        <tr><th>State</th><th>Count</th><th></th></tr>
        ${stateCounts.map(s => {
          const pct = totalLogs > 0 ? (s.count / totalLogs * 100).toFixed(0) : 0;
          return `<tr>
            <td><code>${s._id}</code></td>
            <td>${s.count}</td>
            <td><div class="bar-bg"><div class="bar" style="width:${pct}%"></div></div></td>
          </tr>`;
        }).join('')}
      </table>`}
    </div>

    <div class="card">
      <h2>🚦 Enforcer activity</h2>
      ${enforcerCounts.length === 0 ? '<div class="empty">No enforcer events.</div>' : `
      <table>
        <tr><th>Action</th><th>Count</th></tr>
        ${enforcerCounts.map(e => `<tr>
          <td><span class="pill pill-${e._id}">${e._id}</span></td>
          <td>${e.count}</td>
        </tr>`).join('')}
      </table>`}
    </div>

    <div class="card">
      <h2>⚠️ Top violations caught</h2>
      ${violationCounts.length === 0 ? '<div class="empty">No violations — bot is behaving well!</div>' : `
      <table>
        <tr><th>Violation</th><th>Times caught</th></tr>
        ${violationCounts.map(v => `<tr>
          <td><code>${v._id}</code></td>
          <td>${v.count}</td>
        </tr>`).join('')}
      </table>`}
    </div>

    <div class="card" style="grid-column: 1 / -1;">
      <h2>👥 Recent conversations</h2>
      ${recentPhones.length === 0 ? '<div class="empty">No active conversations in window.</div>' : `
      <table>
        <tr>
          <th>Phone</th>
          <th>Current state</th>
          <th>Turns</th>
          <th>Overrides</th>
          <th>Last seen</th>
        </tr>
        ${recentPhones.map(p => {
          const ago = Math.round((Date.now() - new Date(p.lastSeen).getTime()) / 60000);
          return `<tr>
            <td>+${p._id}</td>
            <td><code>${p.currentState}</code></td>
            <td>${p.turnCount}</td>
            <td>${p.overrideCount > 0 ? '<span class="pill pill-override">' + p.overrideCount + '</span>' : '0'}</td>
            <td>${ago}m ago</td>
          </tr>`;
        }).join('')}
      </table>`}
    </div>
  </div>
</body>
</html>`;
    res.set('Content-Type', 'text/html').send(html);
  } catch (err) {
    console.error('State dashboard HTML error:', err);
    res.status(500).send('Dashboard error: ' + err.message);
  }
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

// Weekly analysis cron — Mondays at 9 AM IST (3:30 AM UTC)
if (CONFIG.WEEKLY_REPORT_ENABLED) {
  const cron = require('node-cron');
  const { runWeeklyAnalysis } = require('./scripts/weekly-cron');
  cron.schedule('30 3 * * 1', async () => {
    console.log('🗓️ Running weekly analysis...');
    try {
      await runWeeklyAnalysis(CONFIG);
    } catch (err) {
      console.error('❌ Weekly cron error:', err.message);
    }
  });
  console.log('🗓️ Weekly cron scheduled: Monday 9 AM IST');
}

// Daily pricing sync from Google Sheets — 6 AM IST (12:30 AM UTC)
if (CONFIG.PRICING_SYNC_ENABLED) {
  const cron = require('node-cron');
  const { syncAll: syncPricing } = require('./scripts/sync-pricing');
  const { invalidateCache: invalidatePricingCache } = require('./prompts/catalog-builder');

  // Run once at startup so fresh deploys pick up latest prices immediately
  syncPricing()
    .then(() => invalidatePricingCache())
    .catch(err => console.error('❌ Initial pricing sync failed:', err.message));

  cron.schedule('30 0 * * *', async () => {
    console.log('💰 Running daily pricing sync...');
    try {
      await syncPricing();
      invalidatePricingCache(); // force fresh read of pricing.json on next message
    } catch (err) {
      console.error('❌ Pricing sync error:', err.message);
    }
  });
  console.log('💰 Pricing sync scheduled: daily 6 AM IST');
}

// v59 — Daily escalation summary to business owner (7 PM IST = 13:30 UTC)
// Sends a WhatsApp message listing all today's escalations needing human follow-up.
// Requires env var OWNER_WHATSAPP_NUMBER (e.g. '917696234000' — no +, no spaces).
if (process.env.OWNER_WHATSAPP_NUMBER) {
  const cron = require('node-cron');
  cron.schedule('30 13 * * *', async () => {
    console.log('📋 Running daily escalation summary...');
    try {
      const sinceMidnight = new Date();
      sinceMidnight.setHours(0, 0, 0, 0);

      const convos = await Conversation.find({
        'metadata.needsHumanFollowup': true,
        'metadata.escalations.timestamp': { $gte: sinceMidnight }
      }).lean();

      // Filter to escalations from today that haven't been notified yet
      const items = [];
      for (const c of convos) {
        const todays = (c.metadata?.escalations || []).filter(
          e => e.timestamp >= sinceMidnight && !e.notifiedAt && !e.resolved
        );
        for (const e of todays) {
          items.push({
            phone: c.customerPhone,
            timestamp: e.timestamp,
            customerMessage: e.customerMessage || '(no message)',
            conversationId: c._id
          });
        }
      }

      if (items.length === 0) {
        console.log('📭 No new escalations to report today.');
        return;
      }

      let summary = `🚨 *Daily Escalation Summary — ${items.length} customer${items.length === 1 ? '' : 's'} waiting for follow-up*\n\n`;
      items.sort((a, b) => a.timestamp - b.timestamp);
      items.forEach((it, idx) => {
        const time = new Date(it.timestamp).toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
        });
        const qMessage = (it.customerMessage || '').substring(0, 140);
        summary += `${idx + 1}. 🕒 ${time} IST | +${it.phone}\n   💬 "${qMessage}"\n\n`;
      });
      summary += `_Please follow up directly on WhatsApp with each customer._`;

      await sendWhatsAppMessage(process.env.OWNER_WHATSAPP_NUMBER, summary);
      console.log(`✅ Daily summary sent to owner (${items.length} escalations)`);

      // Mark these escalations as notified so they don't appear again tomorrow
      const phones = [...new Set(items.map(i => i.phone))];
      for (const phone of phones) {
        await Conversation.updateOne(
          { customerPhone: phone, status: 'active' },
          { $set: { 'metadata.escalations.$[elem].notifiedAt': new Date() } },
          { arrayFilters: [{ 'elem.notifiedAt': { $exists: false }, 'elem.resolved': false }] }
        );
      }
    } catch (err) {
      console.error('❌ Daily escalation summary failed:', err.message);
    }
  });
  console.log('📋 Daily escalation summary scheduled: 7 PM IST');
} else {
  console.log('⏭️ Daily escalation summary disabled (OWNER_WHATSAPP_NUMBER env var not set)');
}

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
