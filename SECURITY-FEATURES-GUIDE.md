# 🔒 Security Features Guide - v32

## New Security Modules Available

Three new security and observability modules have been added to your project:

### 1. logger.js - Structured Logging ✅
### 2. mongodb-encryption.js - Data Encryption ✅
### 3. Content-Type Validation in whatsapp-media-upload.js ✅

---

## 📊 1. Structured Logging (logger.js)

### What It Does
- JSON-formatted logs for production log aggregation
- Multiple log levels (error, warn, info, debug)
- Automatic timestamps and context
- Special functions for WhatsApp, AI, and database operations

### How to Use

#### Basic Usage:
```javascript
const logger = require('./logger');

// Error logging
logger.error('Payment failed', error, { userId: '123', amount: 1000 });

// Warning
logger.warn('Rate limit approaching', { requestCount: 95 });

// Info
logger.info('Order created', { orderId: 'ORD-123', total: 5000 });

// Debug (only in development)
logger.debug('Cache hit', { key: 'product-123', ttl: 3600 });
```

#### WhatsApp Message Logging:
```javascript
logger.logWhatsAppMessage('incoming', phoneNumber, 'text', requestId);
logger.logWhatsAppMessage('outgoing', phoneNumber, 'image', requestId);
```

#### AI Provider Usage:
```javascript
logger.logAIProviderUsage('groq', 'llama-3.1-70b', 1024, requestId);
```

#### Database Operations:
```javascript
const start = Date.now();
// ... database operation ...
logger.logDatabaseOperation('find', 'customers', Date.now() - start, requestId);
```

#### Security Events:
```javascript
logger.logSecurityEvent('invalid_token', 'critical', {
  ip: req.ip,
  attemptedToken: 'xxx...'
}, requestId);
```

### Log Levels

Set log level via environment variable:
```bash
# .env
LOG_LEVEL=info  # error, warn, info, debug
```

**Production:** Use `info` or `warn`
**Development:** Use `debug`

### Output Format

```json
{
  "timestamp": "2025-12-27T11:30:00.000Z",
  "level": "INFO",
  "message": "WhatsApp Message",
  "direction": "incoming",
  "phoneNumber": "919876543210",
  "messageType": "text",
  "requestId": "abc123def456",
  "environment": "production"
}
```

---

## 🔐 2. MongoDB Encryption (mongodb-encryption.js)

### What It Does
- AES-256-GCM encryption for sensitive fields
- Field-level encryption (not full database)
- Automatic encryption/decryption with Mongoose plugin
- Password hashing with salt

### How to Use

#### Option A: Mongoose Plugin (Recommended)

```javascript
const mongoose = require('mongoose');
const { encryptionPlugin } = require('./mongodb-encryption');

const customerSchema = new mongoose.Schema({
  phoneNumber: String,
  email: String,      // Will be encrypted
  address: String,    // Will be encrypted
  gstNumber: String,  // Will be encrypted
  companyName: String
});

// Add encryption plugin
customerSchema.plugin(encryptionPlugin, {
  fields: ['email', 'address', 'gstNumber']
});

const Customer = mongoose.model('Customer', customerSchema);

// Use normally - encryption happens automatically!
const customer = new Customer({
  phoneNumber: '919876543210',
  email: 'user@example.com',        // Encrypted before save
  address: '123 Main St, Delhi',    // Encrypted before save
  gstNumber: '29AAAAA0000A1Z5'      // Encrypted before save
});

await customer.save();  // Fields auto-encrypted

const found = await Customer.findOne({ phoneNumber: '919876543210' });
console.log(found.email); // Auto-decrypted: 'user@example.com'
```

#### Option B: Manual Encryption

```javascript
const { encrypt, decrypt, encryptFields, decryptFields } = require('./mongodb-encryption');

// Encrypt single value
const encryptedEmail = encrypt('user@example.com');
// Result: "a1b2c3...iv:authTag:ciphertext"

// Decrypt single value
const email = decrypt(encryptedEmail);
// Result: "user@example.com"

// Encrypt multiple fields
const customer = {
  name: 'John Doe',
  email: 'john@example.com',
  phone: '9876543210'
};

const encrypted = encryptFields(customer, ['email', 'phone']);
// email and phone are now encrypted

// Decrypt multiple fields
const decrypted = decryptFields(encrypted, ['email', 'phone']);
// email and phone are now decrypted
```

#### Password Hashing

```javascript
const { hashPassword, verifyPassword } = require('./mongodb-encryption');

// Hash password (with salt)
const hashedPassword = hashPassword('mySecretPassword');
// Result: "salt:hash"

// Verify password
const isValid = verifyPassword('mySecretPassword', hashedPassword);
// Result: true
```

### Setup Encryption Key

**CRITICAL: Generate a secure encryption key for production!**

```bash
# Generate key
openssl rand -hex 32

# Add to .env
MONGODB_ENCRYPTION_KEY=your_64_character_hex_key_here
```

**Without this key, a default development key is used (NOT SECURE!)**

### What to Encrypt

**Encrypt these fields:**
- ✅ Email addresses
- ✅ Physical addresses
- ✅ GST numbers
- ✅ Phone numbers (if PII)
- ✅ Any personally identifiable information

**Don't encrypt:**
- ❌ IDs (need for queries)
- ❌ Timestamps
- ❌ Product names
- ❌ Order status
- ❌ Public information

---

## 🖼️ 3. Content-Type Validation (whatsapp-media-upload.js)

### What It Does
- Validates image content-type headers
- Blocks non-image files (prevents malicious uploads)
- Allowed formats: JPEG, PNG, WebP, GIF
- Validates file extensions

### Security Features

**Allowed MIME Types:**
```javascript
'image/jpeg'
'image/jpg'
'image/png'
'image/webp'
'image/gif'
```

**Allowed Extensions:**
```javascript
'.jpg', '.jpeg', '.png', '.webp', '.gif'
```

**Blocked:**
- ❌ HTML files (XSS attacks)
- ❌ SVG files (can contain scripts)
- ❌ Executable files
- ❌ PDF, ZIP, or other document types
- ❌ Any non-image format

### How It Works

```javascript
// Automatic validation in uploadImageToWhatsApp()

const contentType = imageResponse.headers['content-type'];

// Validate content type
if (!isValidImageContentType(contentType, imageUrl)) {
  throw new Error(`Invalid content type: ${contentType}`);
  // Upload blocked, security event logged
}
```

### Security Events Logged

When invalid content is detected:
```
[SECURITY] Blocked invalid content-type: application/javascript for URL: https://...
```

Stats tracked:
```javascript
stats.securityBlocked++;  // Incremented for each blocked upload
```

---

## 🔒 Security Best Practices

### 1. Environment Variables

**Required for production:**
```bash
# .env file

# MongoDB Encryption (CRITICAL!)
MONGODB_ENCRYPTION_KEY=<64-character-hex-key>

# Logging
LOG_LEVEL=info
NODE_ENV=production

# Existing vars
WHATSAPP_TOKEN=<your-token>
MONGODB_URI=<your-mongodb-uri>
# ... etc
```

### 2. Enable All Security Features

```javascript
// server.js additions (recommended)

const logger = require('./logger');
const { encryptionPlugin } = require('./mongodb-encryption');

// Use structured logging throughout
logger.info('Server starting', { port: CONFIG.PORT });

// Add encryption to Customer model
customerSchema.plugin(encryptionPlugin, {
  fields: ['email', 'billingAddress', 'shippingAddress', 'gstNumber']
});

// Log security events
app.use((req, res, next) => {
  if (req.path.includes('/webhook')) {
    logger.logWhatsAppMessage('incoming', req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from, 'webhook', generateRequestId());
  }
  next();
});
```

### 3. Monitor Security Events

**Set up alerts for:**
- Multiple security blocks from same IP
- Repeated authentication failures
- Unusual content-type attempts
- High rate limit violations

```javascript
// Example: Alert on security events
logger.logSecurityEvent('repeated_blocks', 'high', {
  ip: req.ip,
  count: blockCount,
  timeWindow: '1hour'
}, requestId);
```

---

## 📊 Log Aggregation

### Recommended Services

**For structured logs:**
- DataDog
- CloudWatch (AWS)
- Loggly
- Splunk
- ELK Stack

### Example DataDog Setup

```javascript
// All logger.js output is JSON-formatted
// DataDog automatically parses JSON logs

// Query examples:
@level:ERROR
@requestId:abc123
@phoneNumber:919876543210
@environment:production
```

---

## 🧪 Testing Security Features

### Test 1: Structured Logging

```javascript
const logger = require('./logger');

logger.info('Test message', {
  testField: 'value',
  requestId: 'test-123'
});

// Check output: Should be JSON with timestamp, level, message
```

### Test 2: Encryption

```javascript
const { encrypt, decrypt } = require('./mongodb-encryption');

const original = 'sensitive data';
const encrypted = encrypt(original);
const decrypted = decrypt(encrypted);

console.log(original === decrypted); // Should be true
console.log(encrypted.includes(':')); // Should be true (format check)
```

### Test 3: Content-Type Validation

```bash
# Try uploading non-image file
# Should be blocked with security log

curl -X POST <your-media-upload-endpoint> \
  -d '{"url":"https://example.com/malicious.html"}'

# Expected: Error about invalid content type
```

---

## 🎯 Migration Guide

### Add to Existing Project

**1. Install new modules (already created):**
- ✅ logger.js
- ✅ mongodb-encryption.js
- ✅ Updated whatsapp-media-upload.js

**2. Generate encryption key:**
```bash
openssl rand -hex 32
```

**3. Update .env:**
```bash
MONGODB_ENCRYPTION_KEY=<your-generated-key>
LOG_LEVEL=info
```

**4. Update models (optional):**
```javascript
// In your Mongoose models
const { encryptionPlugin } = require('./mongodb-encryption');
schema.plugin(encryptionPlugin, { fields: ['email', 'address'] });
```

**5. Replace console.log (optional):**
```javascript
// Before
console.log('Order created:', orderId);

// After
const logger = require('./logger');
logger.info('Order created', { orderId });
```

**6. Deploy:**
- All features work immediately
- Encryption key required for production
- Logging works with or without log aggregation

---

## ✅ Summary

**Three new security layers added:**

1. ✅ **Structured Logging:** JSON logs for production monitoring
2. ✅ **MongoDB Encryption:** AES-256-GCM for sensitive fields
3. ✅ **Content Validation:** Blocks malicious file uploads

**All features are:**
- Production-ready
- Optional (can enable gradually)
- Backward compatible
- Well documented

**Next steps:**
1. Generate encryption key
2. Add to .env
3. Enable logging in critical paths
4. Add encryption to sensitive models
5. Monitor security events

---

**Your WhatsApp bot now has enterprise-grade security!** 🔒
