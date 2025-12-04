# 📸 Vision AI Setup Guide (Option 1: FREE)

This guide helps you set up **Option 1: FREE vision providers** (Gemini + Google Cloud Vision) for maximum reliability at zero cost.

## Current Configuration: Gemini Vision (FREE)

Your bot already has Gemini Vision configured and working! This guide adds Google Cloud Vision as a backup.

---

## 🎯 Option 1: FREE Only

**Providers:**
1. Gemini Vision (Primary) - Already configured ✅
2. Google Cloud Vision (Backup) - 1000 images/month FREE

**Total Cost:** $0/month

---

## 🔧 Setup Google Cloud Vision (15 minutes)

### Step 1: Create Google Cloud Account

1. Go to: https://console.cloud.google.com/
2. Sign in with your Google account
3. Accept terms of service

### Step 2: Create a Project

1. Click "Select a project" dropdown (top left)
2. Click "NEW PROJECT"
3. **Project name:** `whatsapp-cork-bot` (or any name)
4. Click "CREATE"
5. Wait ~10 seconds for project creation
6. Select your new project from the dropdown

### Step 3: Enable Cloud Vision API

1. In the search bar (top), type: **"Vision AI"**
2. Click **"Cloud Vision API"**
3. Click blue **"ENABLE"** button
4. Wait ~30 seconds for API to enable

### Step 4: Create API Key

1. Click hamburger menu (☰) → **"APIs & Services"** → **"Credentials"**
2. Click **"+ CREATE CREDENTIALS"** → **"API key"**
3. **Copy the API key** that appears (starts with `AIza...`)
4. Click "CLOSE" (don't edit yet)

### Step 5: Restrict API Key (Security)

1. Find your new API key in the list
2. Click the **pencil icon** (Edit) next to it
3. Under **"API restrictions":**
   - Select **"Restrict key"**
   - Search and check **"Cloud Vision API"**
   - Uncheck everything else
4. Under **"Application restrictions"** (optional but recommended):
   - Select **"IP addresses"**
   - Add your server's IP (or `0.0.0.0/0` for any IP)
5. Click **"SAVE"**

### Step 6: Add to Your .env File

Open your `.env` file and add:

```bash
# Google Cloud Vision (Vision Fallback - FREE tier 1000/month)
GOOGLE_CLOUD_VISION_KEY=AIza...your_actual_key_here
```

### Step 7: Restart Your Server

```bash
# Kill existing server
lsof -ti:3000 | xargs kill -9

# Start server with new env variable
node server-production.js
```

---

## ✅ Test Your Setup

Send an image to your WhatsApp bot and check the logs:

### Success Logs:
```
📸 Processing image: media_id_123
🟢 Trying Gemini Vision...
✅ Vision response: That's our Cork Desk Organizer...
```

### Gemini Fails, Google Cloud Works:
```
📸 Processing image: media_id_123
🟢 Trying Gemini Vision...
❌ Gemini Vision failed: Rate limit
⚠️ Gemini Vision unavailable, trying Google Cloud...
🔵 Trying Google Cloud Vision...
✅ Vision response: I can see: Wood, Product, Cork...
```

### All Fail (Text Fallback):
```
📸 Processing image: media_id_123
🟢 Trying Gemini Vision...
❌ Gemini Vision failed
🔵 Trying Google Cloud Vision...
❌ Google Cloud Vision failed
⚠️ Google Cloud Vision unavailable, using fallback...
✅ Vision response: I received your image! However, I'm having trouble...
```

---

## 📊 Free Tier Limits

| Provider | Free Tier | After Limit |
|----------|-----------|-------------|
| **Gemini Vision** | Rate limited (~60 req/min) | Wait or use backup |
| **Google Cloud Vision** | 1000 images/month | $1.50 per 1000 images |

**Recommended Usage:**
- Gemini handles 99% of images (free)
- Google Cloud only triggers if Gemini fails
- With current usage, you'll likely stay under 1000/month

---

## 🔐 Security Best Practices

1. ✅ **API Key Restrictions:** Set in Google Cloud Console
2. ✅ **Never commit .env:** Already in .gitignore
3. ✅ **Use separate keys:** Development vs Production
4. ✅ **Rotate keys regularly:** Every 90 days recommended
5. ✅ **Monitor usage:** Check Google Cloud Console monthly

---

## 🚨 Troubleshooting

### "API key not valid"
- Check if Vision API is enabled in Google Cloud
- Verify API restrictions allow Cloud Vision API
- Wait 5 minutes after creating key (propagation delay)

### "Quota exceeded"
- You've used 1000 images this month
- Either wait until next month or upgrade to paid
- Bot will fall back to text responses automatically

### "Permission denied"
- Check API key restrictions
- Ensure IP address is allowed (if restricted)
- Verify project has billing enabled

### Vision not working at all
- Check `.env` file has correct key
- Restart server after adding key
- Check logs for error messages
- Test with: `curl "https://vision.googleapis.com/v1/images:annotate?key=YOUR_KEY"`

---

## 💰 Cost Comparison

### Current Setup (Gemini only)
- Cost: $0/month
- Reliability: Good
- Downtime: If Gemini rate limited → Text fallback

### With Google Cloud Backup
- Cost: $0/month (under 1000 images)
- Reliability: Excellent
- Downtime: Very rare (both Gemini AND Google down)

---

## 🎉 You're Done!

Your bot now has **dual-provider vision** for maximum reliability at zero cost!

**What happens when customer sends image:**
1. ✅ Gemini analyzes image (FREE, best quality)
2. ❌ If Gemini fails → Google Cloud analyzes (FREE tier)
3. ❌ If both fail → Text fallback (always works)

Test by sending different images:
- Cork product photo
- Logo file (PNG/JPG)
- Quality issue photo
- Random image

All should get intelligent responses! 🚀
