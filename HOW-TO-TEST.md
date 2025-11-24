# How to Test Your WhatsApp AI Chatbot

## Quick Testing Steps

### Step 1: Fix MongoDB (2 min)
1. Open browser: https://cloud.mongodb.com/
2. Login
3. Click "Network Access" (left sidebar)
4. Click "ADD IP ADDRESS"
5. Click "ALLOW ACCESS FROM ANYWHERE"
6. Click "Confirm"

### Step 2: Get New WhatsApp Token (5 min)
1. Open: https://developers.facebook.com/apps/
2. Select your WhatsApp app
3. Click "WhatsApp" → "API Setup"
4. Copy the temporary token
5. Edit your .env file:
   ```bash
   nano .env
   # Change WHATSAPP_TOKEN=old_token
   # To: WHATSAPP_TOKEN=new_token
   # Press Ctrl+O to save, Ctrl+X to exit
   ```

### Step 3: Install ngrok (one time)
```bash
brew install ngrok/ngrok/ngrok
```

### Step 4: Start Your Server (Terminal 1)
```bash
cd /Users/kkaran/whatsapp-claude-bridge
node server-production.js
```
Keep this running!

### Step 5: Start ngrok (Terminal 2 - NEW WINDOW)
```bash
ngrok http 3000
```
You'll see:
```
Forwarding https://abc123.ngrok-free.app -> localhost:3000
```
Copy that URL!

### Step 6: Set Webhook in Meta
1. Go to: https://developers.facebook.com/apps/
2. Your app → WhatsApp → Configuration
3. Callback URL: `https://abc123.ngrok-free.app/webhook` (your ngrok URL + /webhook)
4. Verify Token: `nico_verify_token_12345`
5. Click "Verify and Save"
6. Subscribe to "messages"

### Step 7: TEST!
1. Open WhatsApp on your phone
2. Message your business number: "Hi, do you have cork coasters?"
3. Wait 2-3 seconds
4. AI responds!

## What You'll See

**In Terminal 1 (server):**
```
📨 Incoming webhook
📱 Message from 91XXXXXXXXXX: Hi, do you have cork coasters?
🤖 Processing with Groq AI agent...
✅ Agent response: Hello! Yes, we have cork coasters...
✅ Message sent successfully
```

**On Your Phone:**
You receive an intelligent AI response!

## Test Messages

Try these:
- "Hello"
- "What products do you have?"
- "Price for 100 coasters?"
- "I need samples"
- "Bulk order for 500 pieces"

## Troubleshooting

**MongoDB error?**
→ Did you whitelist IP in Step 1?

**Webhook verification fails?**
→ Check ngrok URL is correct
→ Make sure /webhook is at the end

**No response in WhatsApp?**
→ Check server terminal for errors
→ Make sure both terminals are running
→ Check WhatsApp token is fresh

**Need help?**
→ Check server logs in Terminal 1
→ See START-HERE.md for details
