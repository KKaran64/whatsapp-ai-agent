# WhatsApp Testing Guide

## Current Status
✅ Server code ready and working
✅ Groq AI responding successfully (FREE forever!)
✅ Message queue configured
✅ Database models ready

## What Needs Fixing Before Testing

### 1. MongoDB IP Whitelist (5 minutes)

**Problem:** Your MongoDB Atlas cluster is blocking connections from your server's IP address.

**Solution:**
1. Go to https://cloud.mongodb.com/
2. Login with your account
3. Select your project (the one with Cluster0)
4. Click "Network Access" in the left sidebar
5. Click "Add IP Address" button
6. Choose "ALLOW ACCESS FROM ANYWHERE"
   - Or add your specific IP address for better security
7. Click "Confirm"
8. Wait 1-2 minutes for the changes to take effect

**Why:** MongoDB Atlas requires you to explicitly whitelist IP addresses that can connect to your database.

---

### 2. Refresh WhatsApp Access Token (10 minutes)

**Problem:** Your WhatsApp access token has expired (they expire every 60-90 days).

**Solution:**
1. Go to https://business.facebook.com/
2. Login to your Facebook Business account
3. Navigate to your WhatsApp Business account
4. Go to "WhatsApp Manager" → "API Setup" or "Developer Tools"
5. Find the "Access Token" section
6. Click "Generate Token" or "Create New Token"
7. Copy the new token (starts with EAAZAC...)
8. Update your `.env` file:
   ```bash
   WHATSAPP_TOKEN=YOUR_NEW_TOKEN_HERE
   ```
9. Restart your server

**Alternative Method:**
1. Go to https://developers.facebook.com/
2. Select your app
3. Go to WhatsApp → API Setup
4. Generate a new temporary token (valid for 24 hours) for testing
5. Or create a permanent token with proper permissions

---

### 3. Expose Webhook to Internet

**Problem:** Your server is running on localhost:3000, but WhatsApp needs a public HTTPS URL to send messages.

**Option A: Use ngrok (Quick Testing)**

1. Install ngrok:
   ```bash
   npm install -g ngrok
   # OR download from https://ngrok.com/download
   ```

2. Create free account at https://ngrok.com/ (optional but recommended)

3. Run ngrok:
   ```bash
   ngrok http 3000
   ```

4. You'll see output like:
   ```
   Forwarding  https://abc123.ngrok.io -> http://localhost:3000
   ```

5. Copy that HTTPS URL (e.g., https://abc123.ngrok.io)

6. Your webhook URL will be: `https://abc123.ngrok.io/webhook`

**Note:** Free ngrok URLs change every time you restart ngrok. For permanent URL, use paid ngrok or deploy to production.

**Option B: Deploy to Production (Permanent Solution)**

Deploy to Railway, Render, or Heroku:
- Railway: https://railway.app/ (Free tier available)
- Render: https://render.com/ (Free tier available)
- Heroku: https://heroku.com/ (Paid only now)

---

### 4. Configure WhatsApp Webhook

**Steps:**
1. Go to https://developers.facebook.com/apps/
2. Select your WhatsApp app
3. Go to WhatsApp → Configuration
4. Find "Webhook" section
5. Click "Edit"
6. Enter your webhook URL:
   - For ngrok: `https://abc123.ngrok.io/webhook`
   - For production: `https://your-domain.com/webhook`
7. Enter your Verify Token: `nico_verify_token_12345` (from your .env)
8. Click "Verify and Save"
9. Subscribe to webhook fields:
   - ✅ messages
   - ✅ message_status (optional)

---

## Testing Steps

### Step 1: Fix MongoDB and WhatsApp Token
Complete steps 1 and 2 above

### Step 2: Start Your Server
```bash
cd /Users/kkaran/whatsapp-claude-bridge
node server-production.js
```

You should see:
```
✅ MongoDB connected
✅ Message queue initialized
🚀 WhatsApp-Claude Production Server
📡 Server running on port 3000
```

### Step 3: Start ngrok (New Terminal)
```bash
ngrok http 3000
```

Copy the HTTPS URL

### Step 4: Update WhatsApp Webhook
Configure the webhook in Meta dashboard (step 4 above)

### Step 5: Send Test Message
1. Open WhatsApp on your phone
2. Send a message to your WhatsApp Business number
3. Try: "Hi, do you have cork coasters?"

### Step 6: Check Server Logs
Watch your terminal running the server:
- You should see: `📨 Incoming webhook`
- Then: `🤖 Processing with Groq AI agent...`
- Then: `✅ Message sent successfully`

### Step 7: Check WhatsApp Response
The chatbot should respond to your message!

---

## Test Scenarios

Try these messages to test your AI agent:

1. **Initial Greeting:**
   - "Hello"
   - "Hi"

2. **Product Inquiry:**
   - "Do you have cork coasters?"
   - "What products do you sell?"

3. **Pricing Questions:**
   - "How much for cork coasters?"
   - "What's the price for 50 pieces?"

4. **Sample Requests:**
   - "Can I get samples?"
   - "I need 2 samples to test quality"

5. **Bulk Orders:**
   - "I need 500 cork coasters for corporate gifts"
   - "Bulk order pricing?"

---

## Troubleshooting

### Server won't start
- Check if port 3000 is already in use
- Try: `lsof -ti:3000 | xargs kill -9`
- Then restart server

### MongoDB connection error
- Check IP whitelist in MongoDB Atlas
- Verify MONGODB_URI in .env is correct

### WhatsApp not receiving messages
- Check webhook URL is correct
- Verify webhook is subscribed to "messages"
- Check WhatsApp token is valid
- Look for errors in server logs

### AI not responding
- Check Groq API key is valid
- Check server logs for errors
- Verify Groq API is working: `node test-groq.js`

### ngrok URL expired
- Restart ngrok to get new URL
- Update webhook URL in Meta dashboard
- Consider upgrading to ngrok paid for permanent URL

---

## Production Deployment Checklist

When you're ready to go live:

- [ ] Deploy server to Railway/Render/Heroku
- [ ] Get permanent HTTPS domain
- [ ] Update WhatsApp webhook URL
- [ ] Enable MongoDB IP whitelist for production server
- [ ] Set up Sentry for error monitoring (optional)
- [ ] Set NODE_ENV=production in environment variables
- [ ] Monitor server logs and queue status
- [ ] Test thoroughly with real customers
- [ ] Set up automatic restarts (PM2 or platform default)

---

## Quick Reference

**Your Configuration:**
- Server: http://localhost:3000
- Webhook endpoint: /webhook
- Health check: http://localhost:3000/health
- Stats: http://localhost:3000/stats
- Phone ID: 889566387572168
- Verify Token: nico_verify_token_12345

**Useful Commands:**
```bash
# Start server
node server-production.js

# Start ngrok
ngrok http 3000

# Test Groq AI
node test-groq.js

# Check server health
curl http://localhost:3000/health

# Check stats
curl http://localhost:3000/stats

# Kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

**Important URLs:**
- MongoDB Atlas: https://cloud.mongodb.com/
- Meta Business Suite: https://business.facebook.com/
- Facebook Developers: https://developers.facebook.com/
- ngrok Dashboard: https://dashboard.ngrok.com/
- Upstash Redis: https://console.upstash.com/

---

## Support

If you encounter issues:
1. Check server logs for error messages
2. Verify all environment variables in .env
3. Test each component individually
4. Check Meta's webhook documentation
5. Review Groq API status

---

**Last Updated:** 2025-11-18
**Status:** Ready for testing after MongoDB and WhatsApp token fixes
