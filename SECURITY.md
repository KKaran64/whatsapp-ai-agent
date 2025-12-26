# Security Policy

## Critical Security Notice

**IMPORTANT**: This repository previously contained exposed API keys in the `.env` file. If you forked or cloned this repository before [DATE], you must:

### 1. Rotate ALL API Keys Immediately

The following keys were exposed and must be regenerated:

- **WhatsApp Business API Token** - Regenerate at https://developers.facebook.com/
- **Groq API Keys** (4 keys) - Regenerate at https://console.groq.com/
- **Gemini API Key** - Regenerate at https://makersuite.google.com/
- **MongoDB URI** (contains password) - Change password at https://cloud.mongodb.com/
- **Redis URL** (contains password) - Change password at https://upstash.com/

**AUTOMATED ROTATION**: Use the `rotate-keys.js` script to streamline this process:

```bash
node rotate-keys.js
```

See `KEY-ROTATION-GUIDE.md` for full instructions.

### 2. Ensure WHATSAPP_APP_SECRET is Set

For production deployments, `WHATSAPP_APP_SECRET` **MUST** be set in your environment variables. This is required for webhook signature verification to prevent spoofing attacks.

Get your App Secret from: https://developers.facebook.com/apps/

### 3. Never Commit `.env` Files

The `.env` file is already in `.gitignore`. Always use `.env.example` as a template and keep actual credentials in `.env` (local) or environment variables (production).

## Vulnerability Reporting

If you discover a security vulnerability, please email: [your-security-email]

## Security Updates

### 2025-12-26
- ✅ Removed vulnerable `xlsx` package (prototype pollution)
- ✅ Added `.env.example` template
- ✅ Implemented SSRF protection with URL whitelist
- ✅ Added rate limiting (30 req/min)
- ✅ Implemented cache size limits (1000 max entries)
- ✅ Added file size validation (18MB max)
- ⚠️ API keys in `.env` were exposed - rotation required

## Security Features

### 1. SSRF Protection
- URL whitelist validation prevents internal network access
- Only allows HTTP/HTTPS protocols
- Domain whitelisting enforced

### 2. DoS Protection
- Rate limiting: 30 requests/min with 100ms min interval
- File size limits: 18MB maximum
- Cache size limits: 1000 entries with LRU eviction

### 3. Input Validation
- Phone number format validation
- Message type validation
- URL format validation
- Content-type validation

### 4. WhatsApp Policy Compliance
- Webhook signature verification (when WHATSAPP_APP_SECRET is set)
- 24-hour messaging window respected
- No unsolicited messages
- Proper opt-in flow

## Recommended Security Practices

1. **Use Environment Variables**: Never hardcode credentials
2. **Enable Signature Verification**: Always set WHATSAPP_APP_SECRET in production
3. **Regular Updates**: Run `npm audit` and fix vulnerabilities
4. **Monitor Logs**: Use Sentry or similar for error tracking
5. **Rotate Keys**: Change API keys every 90 days
6. **Use HTTPS**: Always use secure connections
7. **Limit Access**: Use principle of least privilege for MongoDB/Redis access

## Dependencies

Last security audit: 2025-12-26
- All high/critical npm vulnerabilities fixed
- `xlsx` package removed due to unfixable vulnerability
- axios updated to latest version

## Contact

For security concerns, contact: [your-email]
