# Automated API Key Rotation Guide

## Quick Start

Run the automated key rotation tool:

```bash
node rotate-keys.js
```

The tool will:
1. Create a backup of your current `.env` file
2. Prompt you to select which keys to rotate
3. Validate new keys (where possible)
4. Update your local `.env` file
5. Provide instructions for updating Render

## What Gets Rotated

### Supported Keys

1. **Groq API Keys** (4 keys)
   - Fully validated before accepting
   - Get new keys at: https://console.groq.com/keys

2. **Gemini API Key**
   - Fully validated before accepting
   - Get new key at: https://makersuite.google.com/app/apikey

3. **MongoDB URI**
   - Format validated
   - Change password at: https://cloud.mongodb.com/

4. **Redis URL**
   - Get new URL at: https://upstash.com/

5. **WhatsApp Business API** (Manual only)
   - Token: https://developers.facebook.com/
   - App Secret: https://developers.facebook.com/apps/

## Step-by-Step Rotation

### 1. Generate New API Keys

Before running the script, generate new keys from each provider:

| Service | URL | What to get |
|---------|-----|-------------|
| Groq | https://console.groq.com/keys | Create 4 new API keys |
| Gemini | https://makersuite.google.com/app/apikey | Create 1 new API key |
| MongoDB Atlas | https://cloud.mongodb.com/ | Change database password |
| Upstash Redis | https://upstash.com/ | Get connection string with new password |
| WhatsApp | https://developers.facebook.com/ | Regenerate access token |

### 2. Run the Rotation Script

```bash
node rotate-keys.js
```

#### Menu Options:

```
1. Groq API Keys        - Rotate all 4 Groq keys
2. Gemini API Key       - Rotate Gemini key
3. MongoDB URI          - Update MongoDB connection
4. Redis URL            - Update Redis connection
5. All keys             - Rotate everything
6. Custom selection     - Choose specific keys
```

### 3. Update Render Environment Variables

After the script completes, update Render:

1. Go to https://dashboard.render.com/
2. Select your service: **whatsapp-ai-agent-nico-messenger**
3. Click **Environment** tab
4. Update the keys that were rotated:
   - Click **Edit** next to each variable
   - Paste the new value
   - Click **Save Changes**

5. Redeploy your service:
   - Click **Manual Deploy** > **Deploy latest commit**
   - Wait for deployment to complete (~2-3 minutes)

### 4. Verify Everything Works

```bash
# Check health endpoint
curl https://whatsapp-ai-agent-nico-messenger.onrender.com/health

# Expected response:
{
  "status": "ok",
  "version": "ROBUST-v25-MEDIA-UPLOAD-API",
  "groqKeys": 4,
  "services": {
    "mongodb": "connected"
  }
}
```

### 5. Clean Up Backup

Once you've confirmed everything works:

```bash
# List backups
ls -la .env.backup.*

# Delete backup after confirmation
rm .env.backup.XXXXXXXXXX
```

## Validation Details

### Groq API Keys

The script validates Groq keys by making a test API call:

```javascript
POST https://api.groq.com/openai/v1/chat/completions
- 401 response = Invalid key
- Any other response = Valid key
```

### Gemini API Key

Validation via models endpoint:

```javascript
GET https://generativelanguage.googleapis.com/v1/models?key=KEY
- 400/403 response = Invalid key
- 200 response = Valid key
```

### MongoDB URI

Format validation only:

```javascript
- Checks URI structure
- Validates hostname exists
- Does NOT test actual connection
```

### Redis URL

No automatic validation (manual testing required)

## Security Best Practices

1. **Never commit the script output** - It contains your actual keys
2. **Rotate keys every 90 days** - Set a calendar reminder
3. **Keep backups secure** - Delete after confirming rotation worked
4. **Use strong passwords** - For MongoDB and Redis
5. **Rotate immediately if compromised** - Don't wait

## Troubleshooting

### Script won't run

```bash
# Make sure it's executable
chmod +x rotate-keys.js

# Install dependencies
npm install axios readline

# Run with node
node rotate-keys.js
```

### Validation fails for valid key

Some keys may fail validation due to rate limits or network issues. The script will ask if you want to use the key anyway.

```
❌ Validation error: timeout
Use this value anyway? (y/n):
```

Type `y` to proceed with an unvalidated key.

### Render environment update fails

If you can't update Render manually:

1. Use Render CLI:
   ```bash
   npm install -g render-cli
   render login
   render env set GROQ_API_KEY=new_value
   ```

2. Or use Render API (advanced):
   ```bash
   curl -X PUT https://api.render.com/v1/services/SERVICE_ID/env-vars/KEY \
     -H "Authorization: Bearer RENDER_API_KEY" \
     -d '{"value":"new_value"}'
   ```

### Production still using old keys

Render caches environment variables. Force a fresh deployment:

1. Go to Render Dashboard
2. Click **Manual Deploy**
3. Select **Clear build cache & deploy**
4. Wait for deployment to complete

## Automation Schedule

Set up a rotation schedule:

```bash
# Add to crontab for quarterly rotation reminder
0 0 1 */3 * echo "Time to rotate API keys!" | mail -s "Key Rotation Reminder" you@example.com
```

Or use GitHub Actions to remind you:

```yaml
# .github/workflows/key-rotation-reminder.yml
name: Key Rotation Reminder
on:
  schedule:
    - cron: '0 0 1 */3 *'  # First day of every 3 months
jobs:
  remind:
    runs-on: ubuntu-latest
    steps:
      - name: Create Issue
        uses: actions/github-script@v6
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: '🔐 Quarterly API Key Rotation Reminder',
              body: 'Run `node rotate-keys.js` to rotate exposed API keys'
            })
```

## Emergency Rotation

If keys are compromised and you need to rotate IMMEDIATELY:

```bash
# 1. Run rotation script with all keys
node rotate-keys.js
# Select option 5 (All keys)

# 2. Update Render via CLI (faster than dashboard)
npm install -g @render-com/cli
render login

# Update all keys at once
render env set \
  GROQ_API_KEY="new_key_1" \
  GROQ_API_KEY_2="new_key_2" \
  GROQ_API_KEY_3="new_key_3" \
  GROQ_API_KEY_4="new_key_4" \
  GEMINI_API_KEY="new_gemini_key" \
  MONGODB_URI="new_mongo_uri" \
  REDIS_URL="new_redis_url"

# 3. Force immediate deployment
render deploy

# 4. Monitor deployment
render logs
```

## Support

If you encounter issues:

1. Check `SECURITY.md` for manual rotation steps
2. Review `.env.backup.*` files if you need to rollback
3. Test keys individually before rotating all at once
4. Contact support if Render deployment fails

## File Locations

- Script: `./rotate-keys.js`
- Current env: `./.env`
- Backups: `./.env.backup.*`
- This guide: `./KEY-ROTATION-GUIDE.md`
- Security docs: `./SECURITY.md`
