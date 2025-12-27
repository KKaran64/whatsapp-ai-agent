#!/bin/bash

# Quick script to check if WhatsApp token is valid

echo "🔑 Checking WhatsApp Access Token..."
echo ""

# Get token from .env
WHATSAPP_TOKEN=$(grep "^WHATSAPP_TOKEN=" .env 2>/dev/null | cut -d'=' -f2 || echo "")

if [ -z "$WHATSAPP_TOKEN" ]; then
  echo "❌ WHATSAPP_TOKEN not found in .env file"
  exit 1
fi

# Test the token
echo "Testing token (first 20 chars): ${WHATSAPP_TOKEN:0:20}..."
echo ""

HTTP_CODE=$(curl -s -o /tmp/wa_token_test.json -w "%{http_code}" \
  "https://graph.facebook.com/v18.0/me?access_token=$WHATSAPP_TOKEN")

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Token is VALID!"
  echo ""
  echo "Account info:"
  cat /tmp/wa_token_test.json | python3 -m json.tool 2>/dev/null || cat /tmp/wa_token_test.json
  echo ""
else
  echo "❌ Token is INVALID or EXPIRED (HTTP $HTTP_CODE)"
  echo ""
  echo "Error response:"
  cat /tmp/wa_token_test.json
  echo ""
  echo ""
  echo "To fix:"
  echo "1. Go to: https://developers.facebook.com/apps/"
  echo "2. Select your app"
  echo "3. Click: WhatsApp → API Setup"
  echo "4. Click: 'Generate Token'"
  echo "5. Copy the new token"
  echo "6. Update .env file: nano .env"
  echo "7. Restart server: node server.js"
fi

# Cleanup
rm -f /tmp/wa_token_test.json
