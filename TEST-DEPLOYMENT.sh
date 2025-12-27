#!/bin/bash

echo "🧪 Testing Deployment - ROBUST-v26"
echo "===================================="
echo ""

# Get your Render URL from user
echo "Enter your Render app URL (without https://):"
echo "Example: whatsapp-ai-agent-abc123.onrender.com"
read -p "URL: " RENDER_URL

if [ -z "$RENDER_URL" ]; then
  echo "❌ No URL provided. Using placeholder..."
  RENDER_URL="your-app.onrender.com"
fi

echo ""
echo "Testing: https://$RENDER_URL"
echo ""

# Test 1: Health Check
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 1: Health Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

HEALTH_RESPONSE=$(curl -s "https://$RENDER_URL/health" 2>&1)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://$RENDER_URL/health" 2>&1)

echo "HTTP Status: $HTTP_CODE"
echo ""
echo "Response:"
echo "$HEALTH_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$HEALTH_RESPONSE"
echo ""

# Parse response
if echo "$HEALTH_RESPONSE" | grep -q "ROBUST-v26"; then
  echo "✅ Version: ROBUST-v26-PRODUCTION-HARDENED found!"
else
  echo "⚠️  Version: Not v26 - deployment may still be in progress"
fi

if echo "$HEALTH_RESPONSE" | grep -q '"groqKeys": 4'; then
  echo "✅ Groq Keys: 4 keys loaded!"
elif echo "$HEALTH_RESPONSE" | grep -q '"groqKeys": 1'; then
  echo "⚠️  Groq Keys: Only 1 key - env vars may not be loaded yet"
else
  echo "❓ Groq Keys: Unknown status"
fi

if echo "$HEALTH_RESPONSE" | grep -q '"status": "ok"'; then
  echo "✅ Status: Server is healthy!"
else
  echo "❌ Status: Server may have issues"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 2: Deployment Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Server is responding (HTTP 200)"
else
  echo "❌ Server returned HTTP $HTTP_CODE"
  echo "   - 502/503: Deployment in progress, wait 2 minutes"
  echo "   - 404: Check URL is correct"
  echo "   - Other: Check Render logs"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 3: What to Check in Render Dashboard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Go to: https://dashboard.render.com"
echo ""
echo "Check for these in LOGS tab:"
echo "  ✅ Environment variables validated"
echo "  ✅ AI Manager initialized with 4 Groq keys"
echo "  ✅ Loaded product database: 41 products"
echo "  ✅ Server running on port 10000"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 4: WhatsApp Test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Send this message to your WhatsApp Business number:"
echo ""
echo "   Hi"
echo ""
echo "Expected:"
echo "  ✅ You get a response from Priya"
echo "  ✅ Render logs show: [abc123] 📨 Incoming webhook"
echo "  ✅ Render logs show: [abc123] 📱 Valid message: Hi"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$HTTP_CODE" = "200" ] && echo "$HEALTH_RESPONSE" | grep -q "ROBUST-v26"; then
  echo "🎉 DEPLOYMENT SUCCESSFUL!"
  echo ""
  echo "✅ Server is live"
  echo "✅ Version v26 deployed"
  echo "✅ Ready for testing"
  echo ""
  echo "Next: Send a WhatsApp test message!"
elif [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "503" ]; then
  echo "⏳ DEPLOYMENT IN PROGRESS"
  echo ""
  echo "Wait 2-3 minutes and run this script again:"
  echo "  ./TEST-DEPLOYMENT.sh"
else
  echo "⚠️  NEEDS ATTENTION"
  echo ""
  echo "Check Render dashboard logs for errors"
  echo "URL: https://dashboard.render.com"
fi

echo ""
