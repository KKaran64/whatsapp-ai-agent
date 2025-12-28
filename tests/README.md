# Test Suite Documentation

## Overview

This test suite prevents regressions of critical bugs fixed in versions v33-v50.

## Test Files

### 1. `critical-bugs.test.js`
Tests webhook acceptance and basic functionality:
- Webhook signature validation (v47)
- Message deduplication (v49)
- Catalog request handling (v39, v50)
- Quantity handling (v48)
- Product accuracy (v38)
- Rate limiting (v37, v41)

**Usage:**
```bash
npm test
# or
node tests/critical-bugs.test.js
```

### 2. `ai-response-validation.js`
Validates AI response patterns against critical bugs:
- No email asking on catalog requests (v39, v50)
- No quantity hallucination (v48)
- No product switching (v38)
- No rude rate limit messages (v41)
- No image over-promising (v44)

**Usage:**
```bash
npm run test:ai
# or
node tests/ai-response-validation.js
```

**Note:** Requires MongoDB access to read conversation history.

## Running Tests

### Before Deployment
```bash
# Run both test suites
npm test && npm run test:ai
```

### After Deployment
```bash
# Wait 5 minutes for real conversations
sleep 300

# Validate production conversations
npm run test:ai
```

## Test Coverage

| Bug | Version | Test File | Status |
|-----|---------|-----------|--------|
| Webhook signature validation | v47 | critical-bugs.test.js | ✅ |
| Message deduplication | v49 | critical-bugs.test.js | ✅ |
| Catalog email ask | v39, v50 | ai-response-validation.js | ✅ |
| Quantity hallucination | v48 | ai-response-validation.js | ✅ |
| Product switching | v38 | ai-response-validation.js | ✅ |
| Rude rate limiting | v37, v41 | ai-response-validation.js | ✅ |
| Image over-promising | v44 | ai-response-validation.js | ✅ |

## Continuous Integration

Add to `.github/workflows/test.yml`:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Install dependencies
        run: npm install
      - name: Run tests
        run: npm test
        env:
          WHATSAPP_APP_SECRET: ${{ secrets.WHATSAPP_APP_SECRET }}
          MONGODB_URI: ${{ secrets.MONGODB_URI }}
```

## Adding New Tests

When fixing a new bug:

1. **Add test case** to appropriate file
2. **Document in README** (this file)
3. **Run test** before deploying
4. **Verify in production** after deploying

Example:
```javascript
// In ai-response-validation.js
const VALIDATION_RULES = {
  // ... existing rules

  myNewRule: {
    name: 'My new validation',
    trigger: /pattern in customer message/i,
    forbidden: [/bad pattern in response/i],
    required: [/good pattern in response/i],
    description: 'What this rule prevents'
  }
};
```

## Manual Testing Checklist

After deployment, manually test:

- [ ] Catalog request: "Share your catalog"
  - ✅ Should NOT ask for email
  - ✅ Should send PDF

- [ ] Quantity conversation: "I need diaries" → "gifting" → "clients"
  - ✅ Should ask "How many?"
  - ✅ Should NOT assume quantity (200, 100, etc.)

- [ ] Product accuracy: "Do you have diaries?" → "I need 150"
  - ✅ Should mention "diaries" not other products

- [ ] Duplicate messages: Send same message twice quickly
  - ✅ Should respond only ONCE

- [ ] Rate limiting: Send "Hi.." then "Do you have coasters" (1 second apart)
  - ✅ Should NOT send "Please wait" message

## Regression Prevention

**Before adding new features:**
1. Review existing tests
2. Check if new feature conflicts with existing rules
3. Add tests for new feature
4. Run ALL tests before deploying

**If a test fails:**
1. DO NOT deploy
2. Fix the issue
3. Re-run tests
4. Deploy only when all tests pass
