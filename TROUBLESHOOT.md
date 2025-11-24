# No Response Troubleshooting Guide

## Current Status:
- ✅ Server running on localhost:3000
- ✅ ngrok tunnel active: https://bibi-creamiest-draven.ngrok-free.dev
- ❌ **Zero requests received from WhatsApp**

This means WhatsApp is not sending messages to your server.

---

## Step-by-Step Fix:

### Step 1: Verify Webhook Configuration

Go to: https://developers.facebook.com/apps/

1. Select your WhatsApp app
2. Click "WhatsApp" in left sidebar
3. Click "Configuration"
4. Look at "Webhook" section

**What do you see?**

#### Option A: Webhook URL is empty or wrong
→ You need to configure it!

Click "Edit" and enter:
- **Callback URL:** `https://bibi-creamiest-draven.ngrok-free.dev/webhook`
- **Verify Token:** `nico_verify_token_12345`
- Click "Verify and Save"

**If verification fails:**
- Check server is running (should be!)
- Check URL has `/webhook` at the end
- Check verify token is EXACTLY: `nico_verify_token_12345`

#### Option B: Webhook URL is set but shows ❌ Not Verified
→ Click "Edit" and verify again
→ If it still fails, check server logs for errors

#### Option C: Webhook URL is set and shows ✅ Verified
→ Good! Move to Step 2

---

### Step 2: Check Webhook Subscriptions

In the same "Configuration" page:

Look for **"Webhook fields"** section below the webhook URL.

**Check if "messages" is subscribed:**
- ✅ messages (must be checked!)
- ✅ message_status (optional)

**If "messages" is NOT checked:**
1. Click the checkbox next to "messages"
2. Click "Subscribe"
3. Click "Save"

---

### Step 3: Test Webhook Connection

Let me test if your webhook is reachable:

Open a new terminal and run:

```bash
curl -X POST https://bibi-creamiest-draven.ngrok-free.dev/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "1234567890",
            "id": "test123",
            "type": "text",
            "text": {
              "body": "Test message"
            }
          }]
        }
      }]
    }]
  }'
```

**What should happen:**
- You should see logs in your server terminal
- Server should try to process the message

**If you see errors:**
- WhatsApp token might be expired (go to Step 4)

---

### Step 4: Verify WhatsApp Token

Your token expired on Nov 16. You need a fresh token.

1. Go to: https://developers.facebook.com/apps/
2. Your App → WhatsApp → API Setup
3. Look for "Temporary access token"
4. Check expiration date - is it expired?

**If expired:**
1. Click "Generate Token"
2. Copy the new token
3. Update .env file:
   ```bash
   nano .env
   # Update WHATSAPP_TOKEN line
   # Save with Ctrl+O, exit with Ctrl+X
   ```
4. **RESTART SERVER:**
   ```bash
   lsof -ti:3000 | xargs kill -9
   node server-production.js
   ```

---

### Step 5: Send Test Message from WhatsApp

After completing Steps 1-4:

1. Open WhatsApp on your phone
2. Send message to your WhatsApp Business number
3. Try: "Test"

**Watch your server terminal for:**
```
📨 Incoming webhook
📱 Message from ...
```

If you see this, it's working!

---

## Common Issues:

### Issue: "Invalid token" error
**Fix:** Token expired. Get new token (Step 4)

### Issue: Webhook verification fails
**Fix:**
- Check server is running
- Check URL: `https://bibi-creamiest-draven.ngrok-free.dev/webhook`
- Check verify token: `nico_verify_token_12345`
- Check server logs for errors

### Issue: Server receives message but crashes
**Fix:** Likely WhatsApp token issue. Update token and restart.

### Issue: ngrok shows "Session Expired"
**Fix:**
- Restart ngrok: `./ngrok http 3000`
- Get new URL
- Update webhook URL in Meta dashboard

### Issue: MongoDB error
**Don't worry!** MongoDB error won't prevent message receiving.
- The server will still process messages
- Just won't save conversation history
- Fix MongoDB IP whitelist when you have time

---

## Debug Checklist:

- [ ] Server running? (Check: `curl http://localhost:3000/health`)
- [ ] ngrok running? (Check: `curl http://localhost:4040/api/tunnels`)
- [ ] Webhook configured in Meta? (URL + Verify Token)
- [ ] Webhook verified? (Should show ✅)
- [ ] "messages" subscribed? (Must be checked)
- [ ] WhatsApp token fresh? (Check expiration)
- [ ] Sent test message from phone?

---

## Quick Test Script:

```bash
# Test if server is responding
curl http://localhost:3000/health

# Test webhook endpoint (should return 200)
curl -X POST https://bibi-creamiest-draven.ngrok-free.dev/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'

# Check ngrok requests
curl -s http://localhost:4040/api/requests/http | python3 -c "import sys, json; print(len(json.load(sys.stdin)['requests']), 'requests')"
```

---

## What to Check Right Now:

1. **Go to Meta Developer Console:**
   https://developers.facebook.com/apps/

2. **Check Webhook Configuration:**
   - Is callback URL set?
   - Is it verified (✅)?
   - Is "messages" subscribed?

3. **If webhook is NOT configured:**
   - Configure it now with:
   - URL: `https://bibi-creamiest-draven.ngrok-free.dev/webhook`
   - Token: `nico_verify_token_12345`

4. **If webhook IS configured:**
   - Check if WhatsApp token expired
   - Generate new token
   - Update .env
   - Restart server

5. **Then test again from WhatsApp**

---

## Need More Help?

Run this diagnostic:

```bash
cd /Users/kkaran/whatsapp-claude-bridge

echo "=== System Status ==="
echo ""

echo "Server running?"
curl -s http://localhost:3000/health && echo "✅ Server OK" || echo "❌ Server down"

echo ""
echo "ngrok active?"
curl -s http://localhost:4040/api/tunnels | python3 -c "import sys, json; print('✅ ngrok URL:', json.load(sys.stdin)['tunnels'][0]['public_url'])" 2>/dev/null || echo "❌ ngrok down"

echo ""
echo "Requests received?"
curl -s http://localhost:4040/api/requests/http | python3 -c "import sys, json; print('Total:', len(json.load(sys.stdin)['requests']))" 2>/dev/null || echo "0"

echo ""
echo "=== Next Steps ==="
echo "1. Configure webhook in Meta dashboard"
echo "2. URL: https://bibi-creamiest-draven.ngrok-free.dev/webhook"
echo "3. Token: nico_verify_token_12345"
echo "4. Subscribe to 'messages'"
echo "5. Send test message from WhatsApp"
```

Save this as `check-status.sh` and run it to diagnose issues.
