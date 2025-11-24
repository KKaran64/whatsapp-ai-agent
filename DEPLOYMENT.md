# Deploy to Render (Free Tier)

This guide will help you deploy your WhatsApp AI agent to Render for permanent hosting with a stable URL.

## Why Render?

- **100% Free Tier** - No credit card required
- **Stable HTTPS URL** - No more changing webhook URLs
- **Automatic HTTPS** - SSL certificates included
- **Auto-restarts** - Keeps your service running 24/7
- **Easy Git deployment** - Push to GitHub, auto-deploys

---

## Prerequisites

1. GitHub account
2. Render account (free) - https://render.com
3. Your environment variables from `.env` file

---

## Step 1: Push Code to GitHub

### 1.1 Initialize Git Repository (if not already done)

```bash
cd /Users/kkaran/whatsapp-claude-bridge
git init
git add .
git commit -m "Initial commit - WhatsApp AI agent with multi-provider system"
```

### 1.2 Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `whatsapp-ai-agent`
3. Make it **Private** (contains API keys in commit history)
4. Don't initialize with README
5. Click "Create repository"

### 1.3 Push to GitHub

```bash
git remote add origin https://github.com/YOUR_USERNAME/whatsapp-ai-agent.git
git branch -M main
git push -u origin main
```

**IMPORTANT**: Make sure `.env` is listed in `.gitignore` so API keys aren't pushed to GitHub!

---

## Step 2: Deploy to Render

### 2.1 Create Render Account

1. Go to https://render.com
2. Click "Get Started"
3. Sign up with GitHub (easiest option)
4. Authorize Render to access your GitHub repositories

### 2.2 Create New Web Service

1. Click "New +" button → "Web Service"
2. Connect your `whatsapp-ai-agent` repository
3. Click "Connect" next to your repository

### 2.3 Configure Service

**Service Configuration:**
- **Name**: `whatsapp-ai-agent` (or any name you prefer)
- **Region**: Choose closest to you
- **Branch**: `main`
- **Runtime**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Plan**: **Free** (select this!)

### 2.4 Add Environment Variables

Click "Advanced" → "Add Environment Variable" and add ALL these:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `10000` (Render uses this port) |
| `WHATSAPP_TOKEN` | (Copy from your `.env`) |
| `WHATSAPP_PHONE_NUMBER_ID` | (Copy from your `.env`) |
| `VERIFY_TOKEN` | `nico_verify_token_12345` |
| `GROQ_API_KEY` | (Copy from your `.env`) |
| `GEMINI_API_KEY` | (Copy from your `.env`) |
| `ANTHROPIC_API_KEY` | (Copy from your `.env` - optional) |
| `MONGODB_URI` | (Copy from your `.env`) |
| `REDIS_URL` | (Copy from your `.env`) |
| `SENTRY_DSN` | (Leave empty if not using) |

**Where to find values**: Open `/Users/kkaran/whatsapp-claude-bridge/.env` and copy each value.

### 2.5 Deploy

1. Click "Create Web Service"
2. Wait 2-3 minutes for deployment
3. You'll see build logs in real-time
4. When complete, you'll see "Live" with a green checkmark

---

## Step 3: Get Your Permanent URL

After deployment completes, Render will give you a URL like:

```
https://whatsapp-ai-agent.onrender.com
```

**Your webhook URL will be:**
```
https://whatsapp-ai-agent.onrender.com/webhook
```

---

## Step 4: Update Meta Developer Portal

### 4.1 Update Webhook URL

1. Go to https://developers.facebook.com
2. Select your app
3. Go to WhatsApp → Configuration
4. Click "Edit" next to Callback URL
5. Enter: `https://YOUR-APP-NAME.onrender.com/webhook`
6. Verify Token: `nico_verify_token_12345`
7. Click "Verify and Save"

### 4.2 Subscribe to Webhooks

Make sure "messages" field is subscribed:
- Go to WhatsApp → Configuration → Webhook fields
- Check "messages" is subscribed
- If not, click "Subscribe"

---

## Step 5: Test Your Deployment

### 5.1 Check Server Health

Visit: `https://YOUR-APP-NAME.onrender.com/health`

Should return:
```json
{
  "status": "ok",
  "timestamp": "2025-11-24T...",
  "uptime": 123.45,
  "memory": {...}
}
```

### 5.2 Send WhatsApp Test Message

Send a message to your WhatsApp Business number from a whitelisted phone:

**Test 1: Cache**
- Message: "Hi"
- Expected: Instant response from cache

**Test 2: Groq AI**
- Message: "Do you have coasters for corporate gifting?"
- Expected: AI-generated personalized response

**Test 3: Check Logs**

In Render dashboard:
1. Go to your service
2. Click "Logs" tab
3. You should see:
```
🔄 Processing message from queue: +1234567890
🤖 Processing with Multi-Provider AI (Groq → Gemini → Rules)...
⚡ Cache hit - instant response
✅ Response from CACHE: ...
```

---

## Step 6: Monitor Your Service

### 6.1 View Logs

In Render dashboard → Your service → Logs tab:
- Real-time logs
- Filter by keyword
- Download logs for debugging

### 6.2 Check Stats

Visit: `https://YOUR-APP-NAME.onrender.com/stats`

Shows:
- Total messages processed
- Conversation metrics
- System health

### 6.3 Render Dashboard Metrics

Shows:
- CPU usage
- Memory usage
- Request count
- Response times

---

## Troubleshooting

### Issue 1: "Application failed to respond"

**Cause**: Server didn't start properly

**Fix**:
1. Check Render logs for errors
2. Make sure all environment variables are set
3. Verify `PORT` is set to `10000`

### Issue 2: MongoDB Connection Failed

**Cause**: MongoDB Atlas IP whitelist

**Fix**:
1. Go to MongoDB Atlas
2. Network Access → Add IP Address
3. Add `0.0.0.0/0` (allow all IPs) for Render
4. Click "Confirm"

### Issue 3: Redis Connection Failed

**Cause**: Upstash Redis URL incorrect

**Fix**:
1. Check Upstash dashboard for correct URL
2. Make sure `REDIS_URL` starts with `rediss://` (with double 's')
3. Update in Render environment variables

### Issue 4: WhatsApp Webhook Verification Failed

**Cause**: Verify token mismatch

**Fix**:
1. Make sure `VERIFY_TOKEN` in Render = verify token in Meta
2. Both should be: `nico_verify_token_12345`
3. Save and try again

### Issue 5: Messages Not Being Received

**Cause**: Webhook not subscribed or wrong URL

**Fix**:
1. Verify webhook URL is correct in Meta
2. Check "messages" field is subscribed
3. Check Render logs - should see incoming webhook requests
4. If no logs, webhook URL might be wrong

---

## Render Free Tier Limitations

**What's Included (FREE):**
- ✅ 750 hours/month (enough for 24/7)
- ✅ 512 MB RAM
- ✅ Shared CPU
- ✅ Automatic HTTPS
- ✅ Free SSL certificates
- ✅ Auto-restart on crashes

**Limitations:**
- ⚠️ Spins down after 15 minutes of inactivity
- ⚠️ Takes ~30 seconds to spin back up on first request
- ⚠️ Slower than paid tiers

**Impact on Your Bot:**
- First message after 15 min of inactivity: 30-second delay
- Subsequent messages: Instant
- For most businesses: **Perfectly acceptable!**

**To keep always active (optional):**
- Upgrade to paid tier ($7/month) - never spins down
- Or use a free ping service (UptimeRobot) to ping every 10 minutes

---

## Next Steps After Deployment

### 1. Add UptimeRobot (Optional - Keep Always Active)

**Free way to prevent spin-down:**

1. Go to https://uptimerobot.com (free account)
2. Add New Monitor:
   - Type: HTTP(s)
   - URL: `https://YOUR-APP-NAME.onrender.com/health`
   - Interval: 5 minutes
3. This pings your server every 5 minutes to keep it active

### 2. Monitor Provider Usage

Add this endpoint to check AI provider stats:

Visit: `https://YOUR-APP-NAME.onrender.com/ai-stats`

Shows which providers are being used most.

### 3. Set Up Alerts (Optional)

In Render dashboard:
1. Go to your service → Settings
2. Add notification email
3. Get alerts when service goes down

### 4. Add Custom Domain (Optional - Paid)

If you own a domain:
1. Render dashboard → Your service → Settings
2. Custom Domains → Add custom domain
3. Follow DNS setup instructions
4. Update webhook URL in Meta

---

## Updating Your Deployed App

### When You Make Code Changes:

1. **Commit and push to GitHub:**
```bash
git add .
git commit -m "Updated AI prompts"
git push origin main
```

2. **Render auto-deploys!**
   - Render detects the push
   - Automatically rebuilds
   - Redeploys in 2-3 minutes

3. **Monitor deployment:**
   - Go to Render dashboard
   - Watch "Events" tab for deployment status
   - Check logs for any errors

---

## Cost Summary

**Current Setup (100% FREE):**
- Render: **$0/month** (free tier)
- Groq AI: **$0/month** (free tier, 100k tokens/day)
- Gemini AI: **$0/month** (free tier, 15 req/min)
- MongoDB Atlas: **$0/month** (free tier, 512MB)
- Upstash Redis: **$0/month** (free tier, 10k requests/day)

**Total: $0/month for up to 1000+ messages/day!**

**If you exceed free tiers:**
- Render Starter: $7/month (24/7 uptime, no spin-down)
- Groq: Still free (very generous limits)
- Gemini: Still free
- Claude (if enabled): ~$0.50/month for 1000 messages

---

## Support

### Check Deployment Status

Visit: https://YOUR-APP-NAME.onrender.com/health

### View Logs

Render dashboard → Your service → Logs

### Common Log Messages

✅ **Good**:
```
✅ Message queue initialized
🚀 WhatsApp-Claude Production Server
📡 Server running on port 10000
⚡ Cache hit - instant response
🔵 Trying Groq...
✅ Response from GROQ
```

❌ **Bad**:
```
❌ MongoDB connection failed
❌ Redis connection failed
❌ Error sending WhatsApp message
```

---

## Your Deployment Checklist

- [ ] GitHub repository created
- [ ] Code pushed to GitHub
- [ ] Render account created
- [ ] Web service created on Render
- [ ] All environment variables added
- [ ] Service deployed successfully (green checkmark)
- [ ] Health endpoint returns `{"status":"ok"}`
- [ ] Webhook URL updated in Meta Developer Portal
- [ ] Webhook verified successfully
- [ ] "messages" field subscribed in Meta
- [ ] Test message sent and response received
- [ ] Logs show successful processing
- [ ] UptimeRobot configured (optional)

---

## Quick Reference

**Your URLs:**
- Health: `https://YOUR-APP-NAME.onrender.com/health`
- Stats: `https://YOUR-APP-NAME.onrender.com/stats`
- Webhook: `https://YOUR-APP-NAME.onrender.com/webhook`

**Important Files:**
- `server-production.js` - Main server
- `ai-provider-manager.js` - Multi-provider AI system
- `render.yaml` - Render deployment config
- `.env` - Environment variables (NOT committed)

**Helpful Commands:**
```bash
# View local logs
npm start

# Check if server runs locally
curl http://localhost:3000/health

# Push updates
git add .
git commit -m "Update message"
git push origin main
```

---

You now have a production-grade, enterprise-level WhatsApp AI agent running 24/7 for **$0/month**!
