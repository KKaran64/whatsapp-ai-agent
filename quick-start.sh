#!/bin/bash

echo "🚀 WhatsApp AI Chatbot - Quick Start"
echo "===================================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found"
    exit 1
fi

echo "✅ .env file found"
echo ""

# Check if node_modules exists
if [ ! -d node_modules ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

echo "🔍 Checking configuration..."
echo ""

# Check MongoDB
if grep -q "mongodb+srv://" .env; then
    echo "✅ MongoDB URI configured"
else
    echo "❌ MongoDB URI missing in .env"
fi

# Check Groq API
if grep -q "GROQ_API_KEY=gsk_" .env; then
    echo "✅ Groq API key configured"
else
    echo "❌ Groq API key missing in .env"
fi

# Check WhatsApp
if grep -q "WHATSAPP_TOKEN=EAAZAC" .env; then
    echo "✅ WhatsApp token configured"
else
    echo "❌ WhatsApp token missing in .env"
fi

# Check Redis
if grep -q "REDIS_URL=rediss://" .env; then
    echo "✅ Redis URL configured"
else
    echo "❌ Redis URL missing in .env"
fi

echo ""
echo "===================================="
echo ""
echo "📋 NEXT STEPS TO TEST VIA WHATSAPP:"
echo ""
echo "1. Fix MongoDB IP Whitelist:"
echo "   → Go to https://cloud.mongodb.com/"
echo "   → Network Access → Add IP Address"
echo "   → Allow Access from Anywhere"
echo ""
echo "2. Refresh WhatsApp Token (if expired):"
echo "   → Go to https://business.facebook.com/"
echo "   → WhatsApp Manager → API Setup"
echo "   → Generate new token"
echo "   → Update WHATSAPP_TOKEN in .env"
echo ""
echo "3. Start the server:"
echo "   → node server-production.js"
echo ""
echo "4. Expose webhook (new terminal):"
echo "   → ngrok http 3000"
echo "   → Copy the https URL"
echo ""
echo "5. Update WhatsApp webhook:"
echo "   → Go to https://developers.facebook.com/"
echo "   → WhatsApp → Configuration"
echo "   → Enter your ngrok URL/webhook"
echo "   → Verify Token: nico_verify_token_12345"
echo ""
echo "6. Send test message from WhatsApp!"
echo ""
echo "===================================="
echo ""
echo "📖 For detailed instructions, see: TESTING-GUIDE.md"
echo ""
