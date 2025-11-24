# Production Setup Guide

This guide walks you through setting up the production-ready WhatsApp-Claude integration with all enterprise features.

## Features Included

✅ **Database Persistence** - MongoDB for conversation history and customer data
✅ **Message Queue** - Redis + Bull for reliable message processing
✅ **Webhook Security** - Signature validation to prevent unauthorized access
✅ **Rate Limiting** - Protection against abuse and excessive requests
✅ **Error Monitoring** - Sentry integration for tracking and alerting
✅ **Conversation Context** - AI remembers previous messages for better responses
✅ **Graceful Shutdown** - Proper cleanup on server restart
✅ **Health Monitoring** - Status and stats endpoints

---

## Prerequisites

Before you begin, ensure you have:

1. **Node.js 16+** installed
2. **MongoDB** (local or cloud like MongoDB Atlas)
3. **Redis** (local or cloud like Redis Labs/Upstash)
4. **WhatsApp Business API** access (via Meta)
5. **Anthropic Claude API** key
6. **(Optional)** Sentry account for error monitoring

---

## Installation Steps

### 1. Install Dependencies

```bash
cd /Users/kkaran/whatsapp-claude-bridge
npm install
```

This will install:
- Express.js (web server)
- Mongoose (MongoDB ODM)
- Bull + IORedis (message queue)
- Express-rate-limit (rate limiting)
- @sentry/node (error monitoring)
- Axios (HTTP client)
- dotenv (environment variables)

### 2. Set Up MongoDB

**Option A: Local MongoDB**
```bash
# Install MongoDB (macOS)
brew install mongodb-community
brew services start mongodb-community

# Your connection string:
# mongodb://localhost:27017/whatsapp-sales
```

**Option B: MongoDB Atlas (Cloud - Recommended)**
1. Go to https://www.mongodb.com/cloud/atlas
2. Create free cluster
3. Get connection string (looks like: `mongodb+srv://...`)
4. Whitelist your server IP address

### 3. Set Up Redis

**Option A: Local Redis**
```bash
# Install Redis (macOS)
brew install redis
brew services start redis

# Your connection string:
# redis://localhost:6379
```

**Option B: Redis Cloud (Recommended for production)**
1. **Upstash** (free tier): https://upstash.com/
2. **Redis Labs**: https://redis.com/try-free/
3. Get connection string from dashboard

### 4. Configure Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
nano .env  # or use your preferred editor
```

**Required Variables:**
```env
# WhatsApp (from Meta Business Suite)
WHATSAPP_TOKEN=EAAxxxx...
WHATSAPP_PHONE_NUMBER_ID=123456789
WHATSAPP_APP_SECRET=abc123...
VERIFY_TOKEN=your_custom_token_12345

# Claude AI
ANTHROPIC_API_KEY=sk-ant-api03-xxx...

# Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/whatsapp-sales
REDIS_URL=redis://default:password@redis-host:6379

# Optional but recommended
SENTRY_DSN=https://xxx@sentry.io/xxx
NODE_ENV=production
PORT=3000
```

### 5. WhatsApp Business API Setup

1. Go to https://business.facebook.com/
2. Create a Business App (or use existing)
3. Add WhatsApp product
4. Get your credentials:
   - **Phone Number ID**: Settings → API Setup
   - **Access Token**: Temporary token (generate permanent one later)
   - **App Secret**: Settings → Basic → App Secret
5. Set up webhook:
   - **Callback URL**: `https://your-domain.com/webhook`
   - **Verify Token**: Same as in your .env file
   - **Subscribe to**: `messages` field

### 6. Sentry Setup (Optional but Recommended)

1. Go to https://sentry.io/ and create free account
2. Create new project → Node.js
3. Copy DSN (looks like: `https://xxx@xxx.ingest.sentry.io/xxx`)
4. Add to `.env` file

---

## Running the Server

### Development Mode

```bash
# Use original simple server for testing
npm start

# Or with auto-reload
npm run dev
```

### Production Mode

```bash
# Use production server with all features
node server-production.js

# Or with PM2 for process management (recommended)
npm install -g pm2
pm2 start server-production.js --name whatsapp-bot
pm2 save
pm2 startup
```

---

## Deployment Options

### Option 1: Railway (Easiest)

1. Go to https://railway.app/
2. Connect GitHub repo
3. Add environment variables in dashboard
4. Add MongoDB and Redis plugins
5. Deploy!

**Cost:** ~$5-20/month

### Option 2: DigitalOcean App Platform

1. Create account at https://www.digitalocean.com/
2. Create new app from GitHub
3. Add MongoDB and Redis from marketplace
4. Configure environment variables
5. Deploy

**Cost:** ~$10-25/month

### Option 3: AWS/VPS (Full Control)

1. Launch EC2 instance or VPS
2. Install Node.js, MongoDB, Redis
3. Clone your repo
4. Configure nginx as reverse proxy
5. Use PM2 for process management
6. Set up SSL with Let's Encrypt

**Cost:** ~$5-50/month depending on traffic

### Option 4: Heroku

```bash
# Install Heroku CLI
brew install heroku

# Login and create app
heroku login
heroku create your-app-name

# Add MongoDB and Redis addons
heroku addons:create mongolab:sandbox
heroku addons:create heroku-redis:hobby-dev

# Set environment variables
heroku config:set WHATSAPP_TOKEN=xxx
heroku config:set ANTHROPIC_API_KEY=xxx
# ... set all other variables

# Deploy
git push heroku main
```

**Cost:** Free tier available, paid plans from $7/month

---

## Testing the Integration

### 1. Test Webhook Endpoint

```bash
# Health check
curl http://localhost:3000/health

# Expected response:
# {
#   "status": "ok",
#   "timestamp": "2025-01-17T...",
#   "services": {
#     "mongodb": "connected",
#     "queue": "active"
#   }
# }
```

### 2. Check Stats

```bash
curl http://localhost:3000/stats

# Expected response:
# {
#   "customers": 0,
#   "activeConversations": 0,
#   "queue": {
#     "waiting": 0,
#     "active": 0,
#     "completed": 0,
#     "failed": 0
#   }
# }
```

### 3. Send Test WhatsApp Message

Send a message to your WhatsApp Business number from your phone:

```
Hi, do you have cork coasters?
```

Watch the server logs to see the processing:

```bash
# If using PM2
pm2 logs whatsapp-bot

# Expected logs:
# 📨 Incoming webhook: {...}
# 📱 Message from +1234567890: Hi, do you have cork coasters?
# ✅ Message added to queue
# 🔄 Processing message from queue: +1234567890
# ✅ Customer message stored in database
# 🤖 Processing with Claude agent...
# ✅ Agent response: ...
# ✅ Message sent successfully
# ✅ Agent message stored in database
```

### 4. Verify Database

```bash
# Connect to MongoDB
mongosh "your-mongodb-uri"

# Check customers
db.customers.find()

# Check conversations
db.conversations.find()
```

---

## Monitoring & Maintenance

### View Logs

```bash
# PM2 logs
pm2 logs whatsapp-bot

# View errors only
pm2 logs whatsapp-bot --err

# Clear logs
pm2 flush
```

### Monitor Queue

```bash
# Check queue stats
curl http://localhost:3000/stats

# Or use Bull Board for web UI (optional)
npm install bull-board
# Add to server-production.js for dashboard at /admin/queues
```

### Database Maintenance

```bash
# Backup MongoDB
mongodump --uri="your-mongodb-uri" --out=/backup/$(date +%Y%m%d)

# Archive old conversations (older than 30 days)
# Add a cron job or scheduled task
```

### Error Monitoring

If using Sentry:
1. Go to Sentry dashboard
2. View errors and performance
3. Set up alerts for critical issues

---

## Security Checklist

- [ ] Webhook signature validation enabled (WHATSAPP_APP_SECRET set)
- [ ] Rate limiting active (100 req/min default)
- [ ] Environment variables NOT in git (.env in .gitignore)
- [ ] HTTPS enabled for webhook URL
- [ ] MongoDB authentication enabled
- [ ] Redis password set
- [ ] Sentry DSN configured
- [ ] Regular credential rotation schedule
- [ ] Firewall rules configured (only allow Meta IPs)
- [ ] Backup strategy in place

---

## Troubleshooting

### MongoDB Connection Fails

```bash
# Check if MongoDB is running
brew services list  # macOS
sudo systemctl status mongod  # Linux

# Test connection
mongosh "your-mongodb-uri"
```

### Redis Connection Fails

```bash
# Check if Redis is running
redis-cli ping  # Should return PONG

# Or for cloud Redis
redis-cli -u your-redis-url ping
```

### Messages Not Processing

1. Check queue status: `curl http://localhost:3000/stats`
2. View queue errors in logs: `pm2 logs whatsapp-bot --err`
3. Verify ANTHROPIC_API_KEY is valid
4. Check Claude API quota: https://console.anthropic.com/

### Webhook Not Receiving Messages

1. Verify webhook URL is publicly accessible (use ngrok for local testing)
2. Check Meta Business Suite → WhatsApp → Configuration
3. Test webhook verification: `curl http://your-domain/webhook?hub.mode=subscribe&hub.verify_token=your-token&hub.challenge=test`
4. Check server logs for incoming requests

---

## Cost Estimation

**Monthly Costs (Estimated):**

| Service | Free Tier | Paid (Low Volume) | Paid (High Volume) |
|---------|-----------|-------------------|-------------------|
| WhatsApp API | 1,000 conversations/month | $0.005-0.09/conversation | Bulk pricing |
| Claude API | - | ~$3-15 (depending on usage) | $50-200+ |
| MongoDB Atlas | 512MB | $0 | $9-57/month |
| Redis Cloud | 30MB | $0 | $7-50/month |
| Hosting (Railway) | - | $5-10/month | $20-50/month |
| Sentry | 5K errors/month | $0 | $26+/month |
| **Total** | **~$8-25/month** | **~$15-50/month** | **$100-400+/month** |

---

## Scaling Considerations

**For 100-1000 messages/day:**
- Current setup works great
- Free/basic tiers sufficient

**For 1000-10000 messages/day:**
- Upgrade MongoDB to paid tier (more storage)
- Upgrade Redis to paid tier (better performance)
- Consider multiple server instances
- Add load balancer

**For 10000+ messages/day:**
- Horizontal scaling (multiple servers)
- Dedicated Redis cluster
- MongoDB sharding
- CDN for webhook endpoint
- Advanced queue monitoring

---

## Next Steps

1. ✅ Install dependencies
2. ✅ Configure environment variables
3. ✅ Start MongoDB and Redis
4. ✅ Run server locally
5. ✅ Test with real WhatsApp message
6. ✅ Deploy to production
7. ✅ Set up monitoring
8. ✅ Configure backups
9. ✅ Train team on system

---

## Support & Resources

- **WhatsApp Business API Docs**: https://developers.facebook.com/docs/whatsapp
- **Claude API Docs**: https://docs.anthropic.com/
- **MongoDB Docs**: https://docs.mongodb.com/
- **Bull Queue Docs**: https://github.com/OptimalBits/bull
- **Sentry Docs**: https://docs.sentry.io/

---

## Architecture Diagram

```
Customer (WhatsApp)
    ↓
Meta Cloud API
    ↓
Your Webhook (with rate limiting + signature validation)
    ↓
Message Queue (Redis + Bull)
    ↓
Process Message Job
    ├→ Store in MongoDB (conversation history)
    ├→ Get Context from Database
    ├→ Send to Claude API
    └→ Send Response to Customer
    ↓
Error Monitoring (Sentry)
```

Good luck with your deployment! 🚀
