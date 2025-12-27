// ========================================
// PRODUCTION FIXES - ALL 7 IMPROVEMENTS
// ========================================
// Copy each section to the location specified in APPLY-FIXES.md

// ========================================
// FIX #6: Environment Variable Validation
// ========================================
// ADD AFTER LINE 54 (after CONFIG object)

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

// Call it immediately after CONFIG
validateRequiredEnvVars();

// ========================================
// FIX #7: Request ID Generation
// ========================================
// ADD AFTER LINE 54 (crypto is already imported)

function generateRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

// ========================================
// FIX #2: Input Validation Function
// ========================================
// ADD AFTER LINE 791 (before webhook routes)

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

// ========================================
// FIX #4: Per-Phone Rate Limiting
// ========================================
// ADD AFTER LINE 754 (after webhookLimiter)

// Track message timestamps per phone number
const phoneRateLimits = new Map();

// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  const cleanupAge = 5 * 60 * 1000; // 5 minutes

  for (const [phone, timestamp] of phoneRateLimits.entries()) {
    if (now - timestamp > cleanupAge) {
      phoneRateLimits.delete(phone);
    }
  }
}, 5 * 60 * 1000);

function checkPhoneRateLimit(phoneNumber) {
  const now = Date.now();
  const lastMessage = phoneRateLimits.get(phoneNumber) || 0;

  // Allow 1 message per 3 seconds (20 messages per minute max)
  const minInterval = 3000; // 3 seconds

  if (now - lastMessage < minInterval) {
    const waitTime = Math.ceil((minInterval - (now - lastMessage)) / 1000);
    console.warn(`⚠️ Rate limit exceeded for ${phoneNumber} - must wait ${waitTime}s`);
    return false;
  }

  // Update last message time
  phoneRateLimits.set(phoneNumber, now);
  return true;
}

// ========================================
// FIX #3: MongoDB Reconnection Logic
// ========================================
// ADD AFTER LINE 498 (after connectDatabase function)

// Monitor MongoDB connection status and auto-reconnect
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

// ========================================
// FIX #5: Memory Cleanup for conversationMemory
// ========================================
// ADD AFTER LINE 1296 (after server starts)

// Cleanup old conversation memory every 30 minutes to prevent memory leak
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

  // Log memory stats
  const totalConversations = conversationMemory.size;
  const memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  console.log(`📊 Active conversations: ${totalConversations}, Memory: ${memoryMB}MB`);
}, 30 * 60 * 1000); // Every 30 minutes

// Also add immediate cleanup on startup (after 5 minutes)
setTimeout(() => {
  console.log('🧹 Running initial memory cleanup...');
  const initialSize = conversationMemory.size;
  console.log(`📊 Initial conversation memory: ${initialSize} entries`);
}, 5 * 60 * 1000);

// ========================================
// WEBHOOK HANDLER MODIFICATIONS
// ========================================
// These changes need to be made IN the existing webhook handler
// at line 816 (POST /webhook)

/*
FIND this line (around line 836):
  const from = message.from; // Customer's phone number

REPLACE the entire message processing section with:

  const from = message.from;
  const messageBody = message.text?.body || message.image?.caption || '';
  const messageType = message.type;
  const messageId = message.id;
  const mediaId = message.image?.id;

  // FIX #7: Add request ID for tracking
  const requestId = generateRequestId();
  console.log(`[${requestId}] 📨 Incoming webhook from ${from} (${messageType})`);

  // FIX #2: Validate message before processing
  const validation = validateWhatsAppMessage(message);
  if (!validation.valid) {
    console.warn(`[${requestId}] ❌ Invalid message: ${validation.error}`);
    return; // Skip processing invalid messages
  }

  // FIX #4: Check rate limit
  if (!checkPhoneRateLimit(from)) {
    console.warn(`[${requestId}] ⚠️ Rate limit exceeded for ${from}`);
    await sendWhatsAppMessage(from, "Please wait a moment before sending another message. 🙏").catch(() => {});
    return;
  }

  console.log(`[${requestId}] 📱 Valid message from ${from}: ${messageBody || '[IMAGE]'}`);

  // Continue with existing processing logic...
  if ((messageType === 'text' && messageBody) || messageType === 'image') {
    // ... rest of existing code
  }

*/

// ========================================
// DONE!
// ========================================
// See APPLY-FIXES.md for detailed instructions on where to add each section
