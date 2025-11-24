# Configure WhatsApp Webhook - Step by Step

## YOU MUST DO THIS or messages won't work!

Without this configuration, Meta doesn't know where to send WhatsApp messages.

---

## Step-by-Step Instructions:

### Step 1: Open Meta Developer Console
Go to: **https://developers.facebook.com/apps/**

### Step 2: Select Your App
- Click on your WhatsApp app from the list
- If you see multiple apps, choose the one you're using for WhatsApp Business

### Step 3: Navigate to WhatsApp Configuration
- In the left sidebar, find and click **"WhatsApp"**
- Then click **"Configuration"** (or "API Setup")

### Step 4: Find the Webhook Section
- Scroll down to find the **"Webhook"** section
- It might say "Callback URL" or "Webhook URL"

### Step 5: Click Edit
- Click the **"Edit"** button next to the Webhook section

### Step 6: Enter Your Webhook Details

You'll see two fields:

**Field 1: Callback URL**
Copy and paste this EXACTLY:
```
https://bibi-creamiest-draven.ngrok-free.dev/webhook
```

**Field 2: Verify Token**
Copy and paste this EXACTLY:
```
nico_verify_token_12345
```

### Step 7: Verify and Save
- Click the **"Verify and Save"** button
- Meta will send a request to your server to verify it's working
- You should see a ✅ checkmark or "Verified" message

**If verification FAILS:**
- Make sure your server is running (it is!)
- Make sure you copied the URL exactly (including /webhook at the end)
- Make sure verify token is exactly: nico_verify_token_12345
- Try again

### Step 8: Subscribe to "messages"
- Below the webhook URL, you'll see **"Webhook fields"**
- Find the checkbox for **"messages"**
- **CHECK the "messages" box** ✅
- Click **"Subscribe"**

### Step 9: Save Everything
- Click any **"Save"** or **"Save Changes"** button at the bottom
- Wait 30 seconds for changes to take effect

---

## Now Test It!

### Step 10: Send WhatsApp Message
1. Open WhatsApp on your phone
2. Send a message to your WhatsApp Business number
3. Try: **"Hello"**

### Step 11: Check Your Terminal
Watch the terminal where your server is running.

**You should see:**
```
📨 Incoming webhook: {...}
📱 Message from 91XXXXXXXXXX: Hello
✅ Message added to queue
🤖 Processing with Groq AI agent...
✅ Agent response: ...
✅ Message sent successfully
```

### Step 12: Check Your Phone
Within 3-5 seconds, you should receive an AI-powered response!

---

## Troubleshooting:

### Problem: Webhook verification fails

**Possible causes:**
1. Server not running
   - Check: Is the terminal with server still open?
   - Run: `curl http://localhost:3000/health`

2. Wrong URL
   - Make sure: `https://bibi-creamiest-draven.ngrok-free.dev/webhook`
   - Must end with `/webhook`

3. Wrong verify token
   - Must be exactly: `nico_verify_token_12345`
   - Case sensitive!

4. ngrok expired
   - Free ngrok expires after 2 hours
   - Restart: `./ngrok http 3000`
   - Get new URL
   - Update webhook with new URL

### Problem: Webhook verifies but no messages received

**Check these:**
1. Did you subscribe to "messages" field?
   - Go back to webhook configuration
   - Make sure "messages" has a ✅ checkmark

2. WhatsApp token expired?
   - Generate new token in Meta dashboard
   - Update .env file
   - Restart server

3. Sending to correct number?
   - Use your WhatsApp Business number
   - Not your personal number!

### Problem: Message received but no AI response

**Likely causes:**
1. WhatsApp token expired
   - Get new token
   - Update .env: WHATSAPP_TOKEN=new_token
   - Restart server

2. Server crashed
   - Check terminal for errors
   - Restart server: `node server-production.js`

---

## Visual Checklist:

**Before sending test message, verify ALL are done:**

- [ ] Opened https://developers.facebook.com/apps/
- [ ] Selected WhatsApp app
- [ ] Went to WhatsApp → Configuration
- [ ] Found Webhook section
- [ ] Clicked Edit
- [ ] Entered Callback URL: https://bibi-creamiest-draven.ngrok-free.dev/webhook
- [ ] Entered Verify Token: nico_verify_token_12345
- [ ] Clicked "Verify and Save"
- [ ] Saw ✅ Verified success message
- [ ] Checked "messages" checkbox
- [ ] Clicked "Subscribe"
- [ ] Clicked "Save"
- [ ] Waited 30 seconds
- [ ] Server still running in terminal
- [ ] Sent test message from WhatsApp
- [ ] Checked server logs for "📨 Incoming webhook"

---

## Important URLs:

**Your webhook URL:**
```
https://bibi-creamiest-draven.ngrok-free.dev/webhook
```

**Your verify token:**
```
nico_verify_token_12345
```

**Meta Developer Console:**
```
https://developers.facebook.com/apps/
```

**ngrok Dashboard (see requests):**
```
http://localhost:4040
```

---

## Still Not Working?

Run this command to test if webhook is reachable:

```bash
curl -X POST https://bibi-creamiest-draven.ngrok-free.dev/webhook \
  -H "Content-Type: application/json" \
  -d '{"entry":[{"changes":[{"value":{"messages":[{"from":"test","id":"123","type":"text","text":{"body":"test"}}]}}]}]}'
```

**You should see activity in your server terminal.**

If you see activity with curl but not with WhatsApp messages:
- Webhook configuration is incomplete
- "messages" field not subscribed
- WhatsApp token expired

---

**The webhook configuration is THE MOST IMPORTANT STEP. Nothing will work without it!**
