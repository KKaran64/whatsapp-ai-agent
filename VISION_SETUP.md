# Vision API Setup Guide

## Problem: Vision APIs Failing

When customers send images, vision providers may fail due to quota limits or configuration issues.

---

## Solution 1: Multiple Gemini API Keys (RECOMMENDED!)

**v53.30 NEW**: Use multiple Gemini keys for automatic fallback!

### Why Multiple Keys?
- Gemini free tier: 50 requests/day per key
- With 3 keys: 150 requests/day total
- If key 1 hits quota → automatically tries key 2 → then key 3
- NO CODE CHANGES NEEDED - just add comma-separated keys

### How to Add Multiple Gemini Keys

#### Step 1: Generate Multiple API Keys
1. Go to: https://aistudio.google.com/app/apikey
2. Click **"Create API key"** 
3. Generate 2-3 keys (write them down)

#### Step 2: Add to Render (Comma-Separated)
1. Go to Render Dashboard → Your service
2. Go to **Environment** tab
3. Find `GEMINI_API_KEY`
4. Update value to comma-separated keys:
   ```
   GEMINI_API_KEY=AIzaSyA1...,AIzaSyB2...,AIzaSyC3...
   ```
5. Click **"Save Changes"**
6. Service auto-redeploys

#### Verification
Check logs after deployment:
```
🔑 Vision Handler initialized with 3 Gemini key(s)
```

Health check will show:
```json
{
  "providers": {
    "geminiKeysCount": 3
  }
}
```

### How Fallback Works
```
Customer sends image
  ↓
Try Gemini Key 1 → Success ✅ (done!)
  ↓ (if fails)
Try Gemini Key 2 → Success ✅ (done!)
  ↓ (if fails)  
Try Gemini Key 3 → Success ✅ (done!)
  ↓ (if all fail)
Try Claude Vision → ...
```

**Logs example:**
```
🟢 Trying Gemini Vision (key 1/3)...
⚠️ Gemini key 1 failed, trying next key...
🟢 Trying Gemini Vision (key 2/3)...
✅ Gemini Vision succeeded with key 2
```

---

## Solution 2: Add Hugging Face (FREE FOREVER)

Hugging Face has **NO quota limits**.

### Step 1: Get Token
1. Go to: https://huggingface.co/settings/tokens
2. Click **"New token"**
3. Name: `whatsapp-vision`, Type: **Read**
4. Copy token (starts with `hf_...`)

### Step 2: Add to Render
1. Add environment variable:
   - Key: `HUGGINGFACE_TOKEN`
   - Value: `hf_your_token`
2. Save and redeploy

---

## Health Check

Check vision status:
```bash
curl https://your-app.onrender.com/health/vision
```

Example response:
```json
{
  "status": "healthy",
  "workingProviders": 4,
  "providers": {
    "gemini": true,
    "geminiKeysCount": 3,
    "claude": true,
    "googleCloud": true,
    "huggingFace": true
  },
  "stats": {
    "gemini": {
      "success": 45,
      "failures": 5,
      "keyStats": {
        "key1": { "success": 20, "failures": 5 },
        "key2": { "success": 25, "failures": 0 },
        "key3": { "success": 0, "failures": 0 }
      }
    }
  }
}
```

This shows:
- 3 Gemini keys configured
- Key 1: Used 25 times (20 success, 5 quota fails)
- Key 2: Taking over (25 success)
- Key 3: Not used yet (backup)

---

## Recommended Setup

**For maximum reliability:**
1. **3 Gemini API keys** (150 free requests/day)
2. **Hugging Face token** (unlimited, slower but reliable)
3. **Claude API key** (paid, best quality)

Total cost: **$0** for 150 requests/day with Gemini + unlimited fallback!

---

## Troubleshooting

### "All 3 Gemini keys failed"
- Check quota: https://aistudio.google.com/app/apikey
- Generate new keys if quota exhausted
- Hugging Face will take over automatically

### Vision still failing
- Check Render logs for specific errors
- Verify environment variables saved correctly
- Test health endpoint: `/health/vision`
