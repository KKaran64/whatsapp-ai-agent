# WhatsApp-Claude Bridge

Connect your WhatsApp Business number to Claude Code's `whatsapp-sales-qualifier` agent.

## Architecture

```
WhatsApp Customer → Meta Cloud API → Your Webhook Server → Claude API → Agent Response → WhatsApp
```

## Prerequisites

- Node.js 16+ installed
- WhatsApp Business API access (Meta Cloud API)
- Anthropic API key
- Public HTTPS URL for webhook (ngrok for testing, or deployed server)

## Setup Guide

### Step 1: Meta WhatsApp Business Setup

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Click "My Apps" → "Create App"
3. Select "Business" as app type
4. Fill in app details and create
5. Add "WhatsApp" product to your app
6. Go to WhatsApp → Getting Started

**Get your credentials:**
- **Temporary Access Token**: Copy from the Getting Started page
- **Phone Number ID**: Listed under "From" phone number
- **Business Account ID**: In the top section

### Step 2: Local Server Setup

```bash
# Navigate to project directory
cd whatsapp-claude-bridge

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

Edit `.env` file with your credentials:
```env
WHATSAPP_TOKEN=your_access_token_from_meta
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
VERIFY_TOKEN=any_random_string_you_create
ANTHROPIC_API_KEY=sk-ant-your-key-here
PORT=3000
```

### Step 3: Expose Server with ngrok (for testing)

```bash
# Install ngrok if you haven't
# brew install ngrok (Mac)
# or download from https://ngrok.com

# Start your server
npm start

# In another terminal, expose it
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

### Step 4: Configure Webhook in Meta

1. Go to your Meta app → WhatsApp → Configuration
2. Click "Edit" next to Webhook
3. Enter:
   - **Callback URL**: `https://your-ngrok-url.ngrok.io/webhook`
   - **Verify Token**: The same token you set in `.env`
4. Click "Verify and Save"
5. Subscribe to webhook fields:
   - ✓ messages

### Step 5: Test Your Integration

1. Go to WhatsApp → Getting Started in Meta dashboard
2. Find "Send and receive messages" section
3. Add your phone number to receive messages
4. Send a test message to the test number provided
5. Check your server logs to see the message processing
6. You should receive a response from Claude!

## Production Deployment

### Option 1: Deploy to Railway

1. Sign up at [Railway.app](https://railway.app)
2. Create new project from GitHub
3. Add environment variables in Railway dashboard
4. Deploy - Railway provides HTTPS URL automatically
5. Update webhook URL in Meta dashboard

### Option 2: Deploy to Heroku

```bash
# Install Heroku CLI
heroku login
heroku create your-app-name

# Set environment variables
heroku config:set WHATSAPP_TOKEN=your_token
heroku config:set WHATSAPP_PHONE_NUMBER_ID=your_id
heroku config:set VERIFY_TOKEN=your_verify_token
heroku config:set ANTHROPIC_API_KEY=your_key

# Deploy
git push heroku main
```

### Option 3: Deploy to DigitalOcean/AWS/VPS

1. Set up a Ubuntu server
2. Install Node.js and PM2
3. Clone your repository
4. Install dependencies
5. Set up nginx reverse proxy with SSL (Let's Encrypt)
6. Use PM2 to keep server running

```bash
# On your server
npm install -g pm2
pm2 start server.js --name whatsapp-bridge
pm2 startup
pm2 save
```

## Customizing the Agent

The current implementation uses Claude API directly. To customize the agent's behavior, edit the `system` prompt in `server.js:72-78`.

Example customizations:
- Add product catalog information
- Include pricing details
- Add specific qualification questions
- Change tone/personality
- Add multi-language support

## Monitoring

Check logs:
```bash
# Local
tail -f logs/app.log

# PM2 (production)
pm2 logs whatsapp-bridge
```

## Upgrading to Production WhatsApp Number

1. In Meta dashboard, go to WhatsApp → Settings
2. Click "Add phone number"
3. Follow verification process
4. Update `WHATSAPP_PHONE_NUMBER_ID` in your `.env`
5. Restart server

## Security Best Practices

- Never commit `.env` file to git
- Use webhook signature validation in production
- Implement rate limiting
- Add message queue for high volume (Redis/Bull)
- Monitor API usage and costs
- Set up error alerting (Sentry, etc.)

## Troubleshooting

**Webhook not receiving messages:**
- Check ngrok is running and URL is correct
- Verify VERIFY_TOKEN matches in both .env and Meta dashboard
- Check webhook subscriptions are active
- Look at server logs for errors

**Messages not sending:**
- Verify WHATSAPP_TOKEN is valid (they expire every 24h for temporary tokens)
- Check WHATSAPP_PHONE_NUMBER_ID is correct
- Ensure recipient number is verified in Meta dashboard (for test mode)

**Claude not responding:**
- Verify ANTHROPIC_API_KEY is valid
- Check API quota/limits
- Review server logs for error messages

## Cost Considerations

- **WhatsApp**: First 1000 conversations/month free, then ~$0.005-0.09 per conversation
- **Claude API**: ~$3 per million input tokens, ~$15 per million output tokens
- **Hosting**: Free (ngrok testing) to $5-20/month (Railway/Heroku)

## Support

For issues:
- WhatsApp API: [Meta Business Help Center](https://business.facebook.com/business/help)
- Claude API: [Anthropic Documentation](https://docs.anthropic.com)
- This project: Create an issue on GitHub
