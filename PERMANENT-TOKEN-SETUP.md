# 🔐 Setting Up Permanent WhatsApp Access Token

**Problem:** Temporary access tokens expire every 24 hours, requiring constant manual updates.

**Solution:** Create a System User with a permanent access token that never expires.

---

## Step 1: Create System User in Meta Business Suite

### 1.1 Access Meta Business Settings

1. Go to **https://business.facebook.com/settings**
2. If you have multiple businesses, select the one associated with your WhatsApp app
3. In the left sidebar, scroll down to **Users** section
4. Click **System Users**

### 1.2 Create New System User

1. Click **Add** button (top right)
2. Fill in the details:
   - **System User Name**: `WhatsApp Bot System User` (or any name you prefer)
   - **System User Role**: Select **Admin** (recommended for full access)
3. Click **Create System User**

---

## Step 2: Assign System User to WhatsApp App

### 2.1 Add Assets to System User

1. Find your newly created System User in the list
2. Click **Add Assets** button next to it
3. In the popup, select **Apps** tab
4. Find your WhatsApp app in the list
5. Toggle it ON
6. Select permissions:
   - ✅ **Manage app** (required)
   - ✅ **Manage business extension** (required for WhatsApp)
7. Click **Save Changes**

---

## Step 3: Generate Permanent Access Token

### 3.1 Create Access Token

1. Still in the System Users page, find your System User
2. Click **Generate New Token** button
3. In the popup:
   - **App**: Select your WhatsApp app
   - **Token Expiration**: Select **Never** (this is the key!)
   - **Available Permissions**: Check these boxes:
     - ✅ `whatsapp_business_management`
     - ✅ `whatsapp_business_messaging`
     - ✅ `business_management` (optional but recommended)

4. Click **Generate Token**
5. **IMPORTANT**: Copy the token immediately and save it securely
   - This token will look like: `EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   - It will be shown only once!
   - Store it in a password manager or secure note

---

## Step 4: Update Token in Render

### 4.1 Replace Token in Environment Variables

1. Go to **https://render.com/dashboard**
2. Select your `whatsapp-ai-agent` service
3. Click **Environment** tab in the left sidebar
4. Find `WHATSAPP_TOKEN` variable
5. Click the **Edit** icon (pencil)
6. **Delete the old temporary token**
7. **Paste the new permanent token** (starts with `EAA...`)
8. Click **Save Changes**

### 4.2 Wait for Auto-Redeploy

- Render will automatically redeploy your service (takes 2-3 minutes)
- Watch the **Events** tab to see deployment progress
- Wait for **"Deploy live ✅"** message

---

## Step 5: Verify the Permanent Token

### 5.1 Check Server Health

Visit: https://whatsapp-ai-agent.onrender.com/health

Should return:
```json
{
  "status": "ok",
  "timestamp": "2025-11-25T...",
  "uptime": 123.45
}
```

### 5.2 Test WhatsApp Message

Send a test message to your WhatsApp Business number:

**Test Message:** `Hi`

**Expected Response:** Should get instant response from cache

**Test Message 2:** `I need 100 coasters for corporate gifting`

**Expected Response:** Should get AI-powered response asking about branding

### 5.3 Monitor Render Logs

In Render dashboard → Logs tab, you should see:
```
✅ Message queue initialized
🔄 Processing message from queue: +1234567890
🤖 Processing with Multi-Provider AI...
⚡ Cache hit - instant response
✅ Message sent successfully
```

**No token expiration errors!** ✅

---

## Step 6: Update Local .env File (Optional)

If you want to test locally with the permanent token:

1. Open `/Users/kkaran/whatsapp-claude-bridge/.env`
2. Update the `WHATSAPP_TOKEN` line:
   ```env
   WHATSAPP_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
3. Save the file
4. Restart local server: `npm start`

**IMPORTANT:** Never commit `.env` to Git! Make sure `.gitignore` includes `.env`

---

## Troubleshooting

### Issue 1: "System Users" Option Not Visible

**Cause:** You're not an admin of the Meta Business account

**Fix:**
1. Ask the business account owner to add you as an admin
2. Or ask them to create the System User and share the token with you

### Issue 2: "Add Assets" Shows No Apps

**Cause:** The WhatsApp app is not linked to this Business account

**Fix:**
1. Go to https://developers.facebook.com
2. Select your WhatsApp app
3. Settings → Basic → Business Manager
4. Link the app to your Business account

### Issue 3: "Generate Token" Button Not Working

**Cause:** Browser extension blocking popup

**Fix:**
1. Disable ad blockers temporarily
2. Try in incognito/private browsing mode
3. Try different browser (Chrome recommended)

### Issue 4: Token Still Shows as Expired

**Cause:** Old token cached or not saved properly in Render

**Fix:**
1. In Render, delete the old `WHATSAPP_TOKEN` completely
2. Add new environment variable with the permanent token
3. Manually trigger redeploy: Settings → Manual Deploy → Deploy latest commit

### Issue 5: "Invalid OAuth access token"

**Cause:** Copied token incorrectly (has spaces or line breaks)

**Fix:**
1. Re-copy the token from Meta Business Suite
2. Make sure no spaces at beginning or end
3. Token should start with `EAA` and be one continuous string
4. Update in Render and redeploy

---

## Security Best Practices

### ✅ DO:
- Store permanent token securely (password manager)
- Only share with trusted team members
- Rotate token every 6-12 months
- Monitor token usage in Meta Business Suite

### ❌ DON'T:
- Commit token to Git repositories
- Share token in Slack/email/public channels
- Use same token across multiple projects
- Ignore security alerts from Meta

---

## Token Management

### Check Token Status

In Meta Business Suite → System Users:
- View when token was created
- See last time token was used
- Revoke token if compromised

### Rotate Token (Every 6-12 Months)

1. Generate new permanent token (same steps as above)
2. Update in Render environment variables
3. Test bot is working with new token
4. Revoke old token in Meta Business Suite

### Revoke Compromised Token

If token is leaked or compromised:
1. **Immediately** go to Meta Business Suite → System Users
2. Find the System User
3. Click **Remove** next to the token
4. Generate new token and update everywhere

---

## Benefits of Permanent Token

✅ **No More Daily Expiration**
- Token lasts indefinitely (until manually revoked)
- No more "Session has expired" errors
- Bot runs 24/7 without interruption

✅ **Production-Ready**
- Suitable for production deployments
- Meets WhatsApp API best practices
- Required for App Review submission

✅ **Better Security**
- System User has specific permissions
- Can be revoked/rotated without affecting main account
- Activity logged separately in Meta Business Suite

✅ **Easier Management**
- Update once, works forever
- Team members don't need access to your personal Meta account
- Centralized token management in Business Suite

---

## Quick Reference

**Your Setup:**
- **Meta Business Suite**: https://business.facebook.com/settings/system-users
- **Render Dashboard**: https://render.com/dashboard
- **WhatsApp API Setup**: https://developers.facebook.com → Your App → WhatsApp → API Setup

**Token Format:**
- Starts with: `EAA`
- Length: ~180-200 characters
- No spaces or line breaks

**Environment Variable:**
```env
WHATSAPP_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**After updating in Render:**
- Wait 2-3 minutes for auto-redeploy
- Check Events tab for "Deploy live ✅"
- Test with WhatsApp message

---

## Next Steps After Setup

Once your permanent token is working:

1. ✅ **Test full conversation flow** to verify lead qualification
2. ✅ **Set up UptimeRobot** to keep Render service active (prevent cold starts)
3. ✅ **Monitor Render logs** for any issues
4. ✅ **Document token location** for team members
5. ✅ **Set calendar reminder** to rotate token in 6 months

---

## Support

If you encounter issues:
1. Check Render logs for errors
2. Verify token permissions in Meta Business Suite
3. Test token with WhatsApp API curl command
4. Check Meta Business Suite → System Users → Activity log

---

## Summary

**Before:** Temporary token expires every 24 hours → constant manual updates

**After:** Permanent token → set it once, works forever ✅

**Time to complete:** ~10 minutes

**Cost:** $0 (completely free!)

**Result:** Production-ready, never-expiring WhatsApp bot 🚀
