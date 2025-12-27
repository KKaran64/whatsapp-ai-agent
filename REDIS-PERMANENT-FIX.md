# 🔧 Redis SSL - Permanent Fix

**Issue:** Redis queue failing with SSL error
**Error:** `SSL routines:ssl3_get_record:wrong version number`
**Root Cause:** TLS configuration mismatch between client and server

---

## 🔍 Problem Analysis

The current code applies TLS configuration to ALL Redis connections, but:
- Some Redis URLs use `redis://` (non-SSL)
- Some use `rediss://` (SSL required)
- The code doesn't differentiate between them

**Current code (Line 568-576):**
```javascript
messageQueue = new Bull('whatsapp-messages', CONFIG.REDIS_URL, {
  redis: {
    tls: {
      rejectUnauthorized: false
    },
    // ... always applies TLS
  }
});
```

**Problem:** If your Redis URL is `redis://` (non-SSL), applying TLS causes the SSL version error.

---

## ✅ The Permanent Fix

Replace the `connectQueue()` function with this improved version:

### Fix Location: server.js Lines 558-620

**Replace the entire `connectQueue()` function with:**

```javascript
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
      redisConfig.tls = {
        rejectUnauthorized: false,
        requestCert: true,
        agent: false
      };
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
    messageQueue.process(async (job) => {
      const { from, body, messageType, mediaId } = job.data;
      return await handleMessage(from, body, messageType, mediaId);
    });

  } catch (error) {
    console.error('❌ Queue initialization failed:', error.message);
    console.log('⚠️  Falling back to direct message processing');
    messageQueue = null; // Disable queue on connection failure
  }
}
```

---

## 🔍 What This Fix Does

### 1. **SSL Detection** (Lines 566-567)
```javascript
const requiresSSL = CONFIG.REDIS_URL.startsWith('rediss://');
```
- Checks if URL starts with `rediss://` (SSL) or `redis://` (non-SSL)
- Only applies TLS config when actually needed

### 2. **Conditional TLS Config** (Lines 569-583)
```javascript
if (requiresSSL) {
  redisConfig.tls = {
    rejectUnauthorized: false,
    requestCert: true,
    agent: false
  };
}
```
- TLS config only added for SSL connections
- Prevents SSL handshake errors on non-SSL connections

### 3. **Better Logging** (Line 585)
```javascript
console.log(`🔧 Initializing queue with ${requiresSSL ? 'SSL (rediss://)' : 'non-SSL (redis://)'}`);
```
- Shows which mode is being used
- Helps debug connection issues

---

## 📋 Additional Check: Your REDIS_URL Format

You also need to check your REDIS_URL format in Render:

### Go to Render Dashboard
1. https://dashboard.render.com
2. Select: **whatsapp-ai-agent**
3. Click: **Environment**
4. Find: **REDIS_URL**

### Check the Format:

**If it looks like this (non-SSL):**
```
redis://some-redis-host.com:6379
```
**→ Keep as is** (the fix will handle it)

**If it looks like this (SSL required):**
```
rediss://some-redis-host.com:6379
```
**→ Keep as is** (the fix will handle it)

**If it has a password:**
```
redis://username:password@host:port
rediss://username:password@host:port
```
**→ Keep as is** (the fix handles both)

---

## 🚀 Deployment Steps

### Step 1: Apply the Fix Locally

```bash
# The fix will be applied to server.js lines 558-620
```

### Step 2: Commit and Push

```bash
git add server.js
git commit -m "Fix: Redis SSL detection and configuration"
git push origin main
```

### Step 3: Wait for Render to Deploy

- Render will auto-deploy (2-3 minutes)
- Watch logs for the new message: "🔧 Initializing queue with..."

### Step 4: Verify

Check Render logs for:
```
✅ Message queue initialized and connected
```

Instead of:
```
❌ Queue error: SSL routines...
```

---

## 🎯 Expected Results After Fix

### Before (Current):
```
❌ Queue error: SSL routines:ssl3_get_record:wrong version number
{
  "queue": "inactive"
}
```

### After (Fixed):
```
🔧 Initializing queue with SSL (rediss://) [or non-SSL (redis://)]
✅ Message queue initialized and connected
{
  "queue": "active"
}
```

---

## ⚙️ Alternative Solution: Use Different Redis Provider

If the fix above doesn't work, consider switching Redis providers:

### Option A: Upstash (Free Tier)
1. Go to: https://upstash.com
2. Create free Redis database
3. Get connection URL (they provide both `redis://` and `rediss://`)
4. Update REDIS_URL in Render

### Option B: Redis Cloud (Free Tier)
1. Go to: https://redis.com/try-free/
2. Create free database
3. Get connection string
4. Update REDIS_URL in Render

### Option C: Remove Redis (Simplest)
If you don't need async queue processing:
1. Remove REDIS_URL from Render environment variables
2. Server will process messages synchronously (works fine)

---

## 🧪 Testing After Fix

### Test 1: Check Health Endpoint
```bash
curl https://whatsapp-ai-agent-nico-messenger.onrender.com/health
```

Should show:
```json
{
  "services": {
    "queue": "active"  ← Should change from "inactive"
  }
}
```

### Test 2: Send WhatsApp Message
Send "Hi" - message should queue and process

### Test 3: Check Logs
Should see:
```
✅ Message queue initialized and connected
[abc123] 📨 Message queued for processing
```

---

## 📝 Summary

**Root Cause:** TLS config applied to all Redis connections regardless of URL type

**Solution:** Detect SSL requirement from URL and conditionally apply TLS config

**Impact:** Queue will work properly with both SSL and non-SSL Redis

**Deployment:** Code change → Git push → Render auto-deploy → Verify

---

**Ready to apply this fix?**

I'll update server.js with the permanent fix and deploy it now.
