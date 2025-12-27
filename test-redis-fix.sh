#!/bin/bash

echo "🧪 Testing Redis Connection After Fix"
echo "======================================"
echo ""
echo "Waiting for Render to redeploy (2 minutes)..."
sleep 120
echo ""
echo "Testing health endpoint..."
echo ""

curl -s "https://whatsapp-ai-agent-nico-messenger.onrender.com/health" | python3 -m json.tool

echo ""
echo "Check for:"
echo "  ✅ 'queue': 'active' (should change from 'inactive')"
echo "  ✅ 'version': 'ROBUST-v27-REDIS-SSL-FIXED'"
echo ""
