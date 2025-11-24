# START HERE - Test Your WhatsApp AI Chatbot

## What You Have Built

You now have a fully functional WhatsApp AI chatbot using:
- ✅ **Groq AI** (FREE, working perfectly!)
- ✅ **MongoDB Atlas** (FREE tier)
- ✅ **Upstash Redis** (FREE tier)
- ✅ **Bull Queue** (message processing)
- ✅ **Production-ready server**

The AI is responding intelligently and everything works locally!

---

## Quick Test Before WhatsApp (Verify Everything Works)

Let's first make sure the server can start:

```bash
cd /Users/kkaran/whatsapp-claude-bridge
node server-production.js
```

**If you see MongoDB connection error**, that's expected and we'll fix it in Step 1 below.

Press `Ctrl+C` to stop the server.

---

## 6 Steps to Test via WhatsApp

### Step 1: Fix MongoDB IP Whitelist (2 minutes)

Your MongoDB database is blocking connections. Let's fix it:

1. Open in browser: https://cloud.mongodb.com/
2. Login to your MongoDB Atlas account
3. Look for your project (it has "Cluster0")
4. Click **"Network Access"** in the left sidebar (under "Security")
5. Click the **"ADD IP ADDRESS"** button
6. Select **"ALLOW ACCESS FROM ANYWHERE"**
   - This adds `0.0.0.0/0` to the whitelist
   - For production, you can restrict this later
7. Click **"Confirm"**
8. Wait 1-2 minutes for changes to take effect

**Why:** MongoDB Atlas requires explicit IP whitelisting for security.

---

### Step 2: Refresh WhatsApp Access Token (5 minutes)

Your current token expired on Nov 16, 2025. Let's get a new one:

**Option A: Temporary Token (24 hours - Quick for testing)**
1. Go to: https://developers.facebook.com/apps/
2. Select your WhatsApp app
3. Click "WhatsApp" in left sidebar → "API Setup"
4. Look for "Temporary access token"
5. Click "Generate Token"
6. Copy the token (starts with EAAZAC...)
7. Update your `.env` file:
   ```bash
   WHATSAPP_TOKEN=YOUR_NEW_TOKEN_HERE
   ```

**Option B: Permanent Token (60-90 days - Better for production)**
1. Go to: https://business.facebook.com/
2. Navigate to "WhatsApp Manager"
3. Go to "Developer Tools" or "API Setup"
4. Generate a System User token with these permissions:
   - whatsapp_business_messaging
   - whatsapp_business_management
5. Copy and update in `.env`

**After updating .env**, you're ready for Step 3!

---

### Step 3: Install ngrok (3 minutes)

ngrok creates a public HTTPS URL that forwards to your localhost. This is what WhatsApp needs.

**Install ngrok:**

```bash
# Using Homebrew (recommended for Mac)
brew install ngrok/ngrok/ngrok

# OR download directly
# Go to https://ngrok.com/download
# Download the Mac version
# Unzip and move to /usr/local/bin
```

**Sign up for ngrok (FREE):**
1. Go to: https://dashboard.ngrok.com/signup
2. Create free account
3. Get your auth token from: https://dashboard.ngrok.com/get-started/your-authtoken
4. Run: `ngrok config add-authtoken YOUR_AUTH_TOKEN`

---

### Step 4: Start Your Server

Open a terminal and run:

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

**Leave this terminal running!** Don't close it.

---

### Step 5: Start ngrok (New Terminal)

Open a **NEW terminal window** (don't close the server!) and run:

```bash
ngrok http 3000
```

You'll see something like:
```
Forwarding  https://abc123xyz.ngrok-free.app -> http://localhost:3000
```

**Copy that HTTPS URL!** (e.g., `https://abc123xyz.ngrok-free.app`)

Your webhook URL is: `https://abc123xyz.ngrok-free.app/webhook`

**Leave this terminal running too!** Don't close it.

**Note:** Every time you restart ngrok, the URL changes (on free tier). You'll need to update the webhook URL in Meta dashboard each time.

---

### Step 6: Configure WhatsApp Webhook

Now tell WhatsApp where to send messages:

1. Go to: https://developers.facebook.com/apps/
2. Select your WhatsApp app
3. Click **"WhatsApp"** in left sidebar
4. Click **"Configuration"** or **"Webhook Configuration"**
5. You'll see "Callback URL" and "Verify Token" fields

**Enter these values:**
- **Callback URL:** `https://abc123xyz.ngrok-free.app/webhook` (your ngrok URL + /webhook)
- **Verify Token:** `nico_verify_token_12345`

6. Click **"Verify and Save"**
   - WhatsApp will send a verification request to your server
   - Your server will respond with the challenge
   - If successful, you'll see ✅ "Verified"

7. Under "Webhook fields", make sure these are subscribed:
   - ✅ **messages** (required!)
   - ✅ message_status (optional)

8. Click **"Save"**

---

## Testing Time!

You're all set! Now test it:

1. Open **WhatsApp** on your phone
2. Send a message to your **WhatsApp Business number**
3. Try: **"Hi, do you have cork coasters?"**

### What Should Happen:

**In your server terminal**, you should see:
```
📨 Incoming webhook: {...}
📱 Message from 91XXXXXXXXXX: Hi, do you have cork coasters?
✅ Message added to queue
🔄 Processing message from queue
🤖 Processing with Groq AI agent...
✅ Agent response: Hello! Yes, we have cork coasters available...
✅ Message sent successfully
✅ Message processed successfully
```

**In your ngrok terminal**, you'll see HTTP requests:
```
POST /webhook  200 OK
```

**On your phone**, you'll receive an AI-powered response within 2-3 seconds!

---

## Test Scenarios

Try these messages to see your AI in action:

1. **Greeting:** "Hello" or "Hi"
2. **Product Inquiry:** "What products do you have?"
3. **Pricing:** "How much for 100 cork coasters?"
4. **Samples:** "Can I get 2 samples?"
5. **Bulk Order:** "I need 500 coasters for corporate gifts"
6. **Follow-up:** Have a conversation! The AI remembers context.

---

## Troubleshooting

### MongoDB won't connect
- Double-check IP whitelist in MongoDB Atlas
- Make sure you selected "Allow Access from Anywhere"
- Wait 2 minutes after adding IP
- Restart your server

### WhatsApp webhook verification fails
- Check your ngrok URL is correct
- Make sure you included `/webhook` at the end
- Verify token must be exactly: `nico_verify_token_12345`
- Make sure server is running
- Check server logs for errors

### Message sent but no response
- Check server terminal for errors
- Verify Groq API key is valid
- Check ngrok is still running
- Look for "Processing with Groq AI agent" in logs

### ngrok says "Session Expired"
- Free ngrok sessions last 2 hours
- Just restart: `ngrok http 3000`
- Get the new URL
- Update webhook URL in Meta dashboard

### Server crashes or hangs
- Check all environment variables in .env
- Restart server: `Ctrl+C` then `node server-production.js`
- Check if Redis and MongoDB are accessible

---

## What's Next?

Once testing works:

### Deploy to Production (Permanent Solution)

**Using Railway (Recommended - FREE tier):**
1. Go to: https://railway.app/
2. Sign up with GitHub
3. "New Project" → "Deploy from GitHub repo"
4. Connect your repository
5. Add environment variables from .env
6. Deploy!
7. Railway gives you a permanent HTTPS URL
8. Update WhatsApp webhook with Railway URL

**Using Render (Alternative - FREE tier):**
1. Go to: https://render.com/
2. Similar process to Railway
3. Free tier with some limitations

### Production Checklist:
- [ ] Deploy to Railway/Render
- [ ] Get permanent HTTPS domain
- [ ] Update WhatsApp webhook URL (only once!)
- [ ] Whitelist production IP in MongoDB
- [ ] Monitor for errors
- [ ] Test with real customers
- [ ] Set up Sentry (optional error monitoring)

---

## Quick Commands Reference

```bash
# Start server
cd /Users/kkaran/whatsapp-claude-bridge
node server-production.js

# Start ngrok (new terminal)
ngrok http 3000

# Check if server is running
curl http://localhost:3000/health

# Check stats
curl http://localhost:3000/stats

# Test Groq AI
node test-groq.js

# Stop server
Ctrl+C

# Kill anything on port 3000
lsof -ti:3000 | xargs kill -9
```

---

## Important URLs

- MongoDB Atlas: https://cloud.mongodb.com/
- Meta Developers: https://developers.facebook.com/
- Meta Business: https://business.facebook.com/
- ngrok Dashboard: https://dashboard.ngrok.com/
- Upstash Redis: https://console.upstash.com/
- Railway: https://railway.app/
- Render: https://render.com/

---

## Current Configuration

```
Phone Number ID: 889566387572168
Verify Token: nico_verify_token_12345
AI Provider: Groq (FREE)
Database: MongoDB Atlas (FREE)
Queue: Upstash Redis (FREE)
Server Port: 3000
```

---

## Need Help?

If you get stuck:
1. Check server logs (terminal running server)
2. Check ngrok logs (terminal running ngrok)
3. Review TESTING-GUIDE.md for detailed troubleshooting
4. Check Meta's webhook documentation
5. Verify all .env variables are correct

---

**Remember:**
- Server must be running
- ngrok must be running
- Both terminals stay open while testing
- Free ngrok URL changes each restart
- Update webhook URL in Meta dashboard when ngrok URL changes

---

**You're ready to test! Good luck! 🚀**

Start with Step 1 (MongoDB IP whitelist) and work your way through all 6 steps.
