# Detailed Fix Application Guide

## 🎯 How to Apply All 7 Fixes

This guide shows you **exactly** where to add each fix in `server.js`.

---

## 📝 Method 1: Manual Copy-Paste (Recommended)

Open `server.js` and `fixes-to-add.js` side by side.

### Fix #6: Environment Validation
**Location**: After line 54 (right after `};` closing CONFIG)

```javascript
// After this line:
};

// ADD THIS:
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

// Before this line:
// Initialize Groq AI (legacy - kept for compatibility)
```

---

### Fix #7: Request ID Function
**Location**: After line 54 (after the environment validation you just added)

```javascript
// ADD THIS:
function generateRequestId() {
  return crypto.randomBytes(6).toString('hex');
}
```

---

### Fix #3: MongoDB Reconnection
**Location**: After line 498 (right after `connectDatabase()` function ends)

Find this:
```javascript
  }
}
// <-- ADD HERE
```

Add this:
```javascript
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
```

---

### Fix #4: Per-Phone Rate Limiting
**Location**: After line 754 (right after `webhookLimiter` definition)

Find this:
```javascript
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
// <-- ADD HERE
```

Add this:
```javascript
// Track message timestamps per phone number
const phoneRateLimits = new Map();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const cleanupAge = 5 * 60 * 1000;

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
  const minInterval = 3000;

  if (now - lastMessage < minInterval) {
    const waitTime = Math.ceil((minInterval - (now - lastMessage)) / 1000);
    console.warn(`⚠️ Rate limit exceeded for ${phoneNumber} - must wait ${waitTime}s`);
    return false;
  }

  phoneRateLimits.set(phoneNumber, now);
  return true;
}
```

---

### Fix #2: Input Validation
**Location**: After line 791 (before webhook GET route)

Find this:
```javascript
}

// Webhook verification (required by Meta)
app.get('/webhook', (req, res) => {
```

Add this BEFORE `app.get('/webhook'`:
```javascript
// Validate WhatsApp messages before processing
function validateWhatsAppMessage(message) {
  try {
    if (!message.from || !/^\d{10,15}$/.test(message.from)) {
      return { valid: false, error: 'Invalid phone number format' };
    }

    const validTypes = ['text', 'image', 'audio', 'video', 'document', 'sticker'];
    if (!message.type || !validTypes.includes(message.type)) {
      return { valid: false, error: `Unsupported message type: ${message.type}` };
    }

    const body = message.text?.body || message.image?.caption || '';

    if (body.length > 4096) {
      return { valid: false, error: 'Message too long (max 4096 characters)' };
    }

    const sanitized = body.replace(/<[^>]*>/g, '').trim();

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
```

---

### Fix #2, #4, #7: Update Webhook Handler
**Location**: Line 836 (inside POST /webhook handler)

Find this code:
```javascript
const message = messages[0];
const from = message.from; // Customer's phone number
const messageBody = message.text?.body || message.image?.caption || '';
const messageType = message.type;
const messageId = message.id;
const mediaId = message.image?.id; // For image messages

console.log(`📱 Message from ${from} (${messageType}): ${messageBody || '[IMAGE]'}`);

// Process text messages AND image messages
if ((messageType === 'text' && messageBody) || messageType === 'image') {
```

Replace with:
```javascript
const message = messages[0];
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
  return;
}

// FIX #4: Check rate limit
if (!checkPhoneRateLimit(from)) {
  console.warn(`[${requestId}] ⚠️ Rate limit exceeded for ${from}`);
  await sendWhatsAppMessage(from, "Please wait a moment before sending another message. 🙏").catch(() => {});
  return;
}

console.log(`[${requestId}] 📱 Valid message: ${messageBody || '[IMAGE]'}`);

// Process text messages AND image messages
if ((messageType === 'text' && messageBody) || messageType === 'image') {
```

---

### Fix #5: Memory Cleanup
**Location**: After line 1296 (right after `app.listen()` closes)

Find this:
```javascript
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 WhatsApp-Claude Production Server`);
  console.log(`📡 Server running on port ${CONFIG.PORT}`);
  console.log(`🔗 Webhook URL: https://your-domain.com/webhook`);
  console.log(`🏥 Health check: http://localhost:${CONFIG.PORT}/health`);
  console.log(`📊 Stats: http://localhost:${CONFIG.PORT}/stats\n`);

  console.log('🔄 Connecting to databases...');
  connectDatabase().catch(err => console.error('Database connection failed:', err));
  connectQueue().catch(err => console.error('Queue connection failed:', err));
});
// <-- ADD HERE
```

Add this:
```javascript
// Cleanup old conversation memory every 30 minutes
setInterval(() => {
  const now = Date.now();
  const TTL = 60 * 60 * 1000; // 1 hour

  let cleaned = 0;
  for (const [phone, messages] of conversationMemory.entries()) {
    if (messages.length === 0) {
      conversationMemory.delete(phone);
      cleaned++;
      continue;
    }

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

  const totalConversations = conversationMemory.size;
  const memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  console.log(`📊 Active conversations: ${totalConversations}, Memory: ${memoryMB}MB`);
}, 30 * 60 * 1000);

setTimeout(() => {
  console.log('🧹 Running initial memory cleanup...');
  const initialSize = conversationMemory.size;
  console.log(`📊 Initial conversation memory: ${initialSize} entries`);
}, 5 * 60 * 1000);
```

---

## ✅ Verification

After adding all fixes, verify with:

```bash
# Check syntax
node -c server.js

# Should output nothing (means no errors)
```

---

## 🧪 Test

```bash
# Start server
node server.js

# Expected output:
# ✅ Environment variables validated
# 🔧 Initializing AI Manager...
# ... (rest of startup)
```

---

## 📊 What Changed

```bash
# See what you added
git diff server.js

# Or compare line counts
wc -l server.js.backup.* server.js
```

You should have added approximately **120-150 lines** of new code.

---

## 🔄 Rollback

If anything goes wrong:

```bash
# Find backups
ls -lt server.js.backup.*

# Restore
cp server.js.backup.YYYYMMDD_HHMMSS server.js
```

---

## 📞 Need Help?

If you get stuck:
1. Check syntax: `node -c server.js`
2. Review error message
3. Compare with `fixes-to-add.js`
4. Each fix is independent - you can add them one at a time
