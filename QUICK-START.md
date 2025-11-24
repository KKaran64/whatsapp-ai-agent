# 🚀 Quick Start Guide

Production-ready WhatsApp integration is ready! Here's what you need to know.

---

## ✅ What's Been Built

### 1. **Production Server** (`server-production.js`)
- ✅ MongoDB database for conversation history
- ✅ Redis message queue for reliability
- ✅ Webhook signature validation
- ✅ Rate limiting (100 req/min)
- ✅ Sentry error monitoring
- ✅ Conversation context memory
- ✅ Customer tracking
- ✅ Stats & health endpoints

### 2. **Database Models**
- `models/Customer.js` - Customer profiles and tracking
- `models/Conversation.js` - Message history with context

### 3. **Documentation**
- `PRODUCTION-SETUP.md` - Complete setup guide
- `COMPARISON.md` - Simple vs Production comparison
- `.env.example` - Environment configuration template
- `QUICK-START.md` - This file!

---

## 🎯 Next Steps

### For Testing (Right Now)

**Option A: Test with Simple Server (No DB required)**
```bash
cd /Users/kkaran/whatsapp-claude-bridge

# Your existing server still works!
node server.js
```
This uses your existing setup - no database needed, perfect for quick tests.

### For Production (When Ready)

**Step 1: Install MongoDB (Choose One)**

Local (Mac):
```bash
brew install mongodb-community
brew services start mongodb-community
```

Cloud (Recommended):
- Sign up at https://www.mongodb.com/cloud/atlas
- Create free cluster
- Get connection string
- Add to `.env` as `MONGODB_URI`

**Step 2: Install Redis (Choose One)**

Local (Mac):
```bash
brew install redis
brew services start redis
```

Cloud (Recommended):
- Sign up at https://upstash.com/ (free tier)
- Create database
- Get connection string
- Add to `.env` as `REDIS_URL`

**Step 3: Update .env File**
```bash
# Copy your existing .env and add these:
MONGODB_URI=mongodb://localhost:27017/whatsapp-sales  # or cloud URI
REDIS_URL=redis://localhost:6379  # or cloud URI
WHATSAPP_APP_SECRET=your_app_secret_from_meta  # For signature validation
SENTRY_DSN=  # Optional - leave empty for now
```

**Step 4: Run Production Server**
```bash
node server-production.js
```

**Step 5: Test It!**
Send a WhatsApp message to your business number and watch it:
- Store in database
- Remember conversation context
- Process through queue
- Respond intelligently

---

## 📊 Check System Status

### Health Check
```bash
curl http://localhost:3000/health
```

### Stats Dashboard
```bash
curl http://localhost:3000/stats
```

Shows:
- Total customers
- Active conversations
- Message queue status

---

## 🔍 Monitor Your Bot

### View Logs (if using PM2)
```bash
pm2 logs whatsapp-bot --lines 100
```

### Check Database
```bash
# Connect to MongoDB
mongosh mongodb://localhost:27017/whatsapp-sales

# View customers
db.customers.find().pretty()

# View conversations
db.conversations.find().pretty()

# Exit
exit
```

### Check Queue
```bash
# Connect to Redis
redis-cli

# Check queue
KEYS bull:whatsapp-messages:*

# Exit
exit
```

---

## 🎭 Which Server Should I Use?

### Use `server.js` (Simple) For:
- ✅ Quick testing NOW
- ✅ Learning how it works
- ✅ Don't want to set up database yet
- ✅ Low volume (<50 messages/day)

### Use `server-production.js` For:
- ✅ Real business use
- ✅ Need conversation memory
- ✅ Higher volume (100+ messages/day)
- ✅ Want customer tracking
- ✅ Need reliability

**You can start with simple and switch to production anytime!**

---

## 💡 Real-World Example

### Simple Server Conversation:
```
Customer: "Hi, do you have coasters?"
Bot: "Yes! We have cork coasters from Rs 22-120..."

[Later that day...]

Customer: "I need 2"
Bot: "I'm sorry, I don't understand. Can you clarify?"
```
❌ Bot forgot the context

### Production Server Conversation:
```
Customer: "Hi, do you have coasters?"
Bot: "Yes! We have cork coasters from Rs 22-120..."

[Later that day...]

Customer: "I need 2"
Bot: "Got it! You need 2 coasters as samples. Which design interests you?"
```
✅ Bot remembers the conversation!

---

## 🚨 Troubleshooting

### "Cannot connect to MongoDB"
```bash
# Check if MongoDB is running
brew services list

# If not running, start it
brew services start mongodb-community
```

### "Cannot connect to Redis"
```bash
# Check if Redis is running
redis-cli ping  # Should return PONG

# If not running, start it
brew services start redis
```

### "Webhook not receiving messages"
- Check WhatsApp Business API settings in Meta Business Suite
- Verify webhook URL is publicly accessible
- For local testing, use ngrok: `ngrok http 3000`

### "Bot responds slowly"
- Check Redis queue: `curl http://localhost:3000/stats`
- Check Claude API quota at https://console.anthropic.com/
- View error logs for issues

---

## 📁 Project Structure

```
whatsapp-claude-bridge/
├── server.js                    # Simple server (original)
├── server-production.js         # Production server (NEW)
├── models/
│   ├── Customer.js             # Customer database model
│   └── Conversation.js         # Conversation history model
├── package.json                # Dependencies
├── .env                        # Your credentials (DO NOT COMMIT)
├── .env.example                # Template for .env
├── PRODUCTION-SETUP.md         # Full setup guide
├── COMPARISON.md               # Simple vs Production
└── QUICK-START.md              # This file
```

---

## 🎯 Recommended Path

### Week 1: Test & Learn
1. Keep using `server.js` for testing
2. Read through `COMPARISON.md`
3. Test with real customers
4. Get familiar with WhatsApp API

### Week 2: Prepare for Production
1. Set up MongoDB Atlas (free tier)
2. Set up Upstash Redis (free tier)
3. Update `.env` with new connection strings
4. Test `server-production.js` locally

### Week 3: Go Live
1. Deploy to Railway/Heroku
2. Point WhatsApp webhook to production URL
3. Enable Sentry monitoring
4. Monitor and iterate

---

## 💰 Cost Breakdown

### Development (Now)
- **WhatsApp API:** Free (1000 conversations/month)
- **Claude API:** ~$3-10/month (light testing)
- **Server:** $0 (running locally)
- **Total:** ~$3-10/month

### Production (When Ready)
- **WhatsApp API:** ~$5-20/month
- **Claude API:** ~$10-50/month
- **MongoDB Atlas:** $0 (free tier)
- **Redis Cloud:** $0 (free tier)
- **Hosting:** $5-10/month (Railway)
- **Total:** ~$20-80/month

---

## 🆘 Need Help?

1. **WhatsApp Setup Issues:** Check Meta Business Suite docs
2. **Claude API Issues:** Check https://console.anthropic.com/
3. **Database Issues:** Check MongoDB Atlas dashboard
4. **Queue Issues:** Check Redis connection
5. **General Issues:** Review `PRODUCTION-SETUP.md`

---

## 🎉 You're Ready!

**Everything is set up and ready to go!**

### To Start Testing NOW:
```bash
node server.js  # Uses your existing simple setup
```

### To Use Production Features:
```bash
# Install MongoDB + Redis first
node server-production.js  # Uses full production stack
```

### Your Current Customer Conversation:
The WhatsApp agent is already handling your customer inquiry about coasters! You can:
1. Continue using the manual responses I provided
2. Start the server to automate responses
3. Test with more customer scenarios

**Good luck! 🚀**
