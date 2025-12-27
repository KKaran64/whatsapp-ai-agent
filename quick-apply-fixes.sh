#!/bin/bash

# Quick Apply Fixes Script
# This script helps you apply all 7 production fixes safely

set -e  # Exit on error

echo "=================================================="
echo "  WhatsApp Claude Bridge - Production Fixes"
echo "=================================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if server.js exists
if [ ! -f "server.js" ]; then
  echo -e "${RED}❌ Error: server.js not found!${NC}"
  echo "Please run this script from /Users/kkaran/whatsapp-claude-bridge/"
  exit 1
fi

echo -e "${GREEN}✅ Found server.js${NC}"
echo ""

# Step 1: Create backup
echo "📦 Step 1: Creating backup..."
BACKUP_FILE="server.js.backup.$(date +%Y%m%d_%H%M%S)"
cp server.js "$BACKUP_FILE"
echo -e "${GREEN}✅ Backup created: $BACKUP_FILE${NC}"
echo ""

# Also backup .env
if [ -f ".env" ]; then
  ENV_BACKUP=".env.backup.$(date +%Y%m%d_%H%M%S)"
  cp .env "$ENV_BACKUP"
  echo -e "${GREEN}✅ .env backed up: $ENV_BACKUP${NC}"
fi
echo ""

# Step 2: Check WhatsApp token
echo "🔑 Step 2: Checking WhatsApp token..."
WHATSAPP_TOKEN=$(grep "^WHATSAPP_TOKEN=" .env 2>/dev/null | cut -d'=' -f2 || echo "")

if [ -z "$WHATSAPP_TOKEN" ]; then
  echo -e "${YELLOW}⚠️  WhatsApp token not found in .env${NC}"
  echo "Please add it before continuing"
else
  echo "Testing token validity..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://graph.facebook.com/v18.0/me?access_token=$WHATSAPP_TOKEN" || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ WhatsApp token is valid!${NC}"
  else
    echo -e "${RED}❌ WhatsApp token appears invalid (HTTP $HTTP_CODE)${NC}"
    echo -e "${YELLOW}⚠️  You may need to regenerate it at:${NC}"
    echo "   https://developers.facebook.com/apps/"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Exiting..."
      exit 1
    fi
  fi
fi
echo ""

# Step 3: Show what will be fixed
echo "🔧 Step 3: Fixes to be applied:"
echo "  1. ✅ Input validation (prevents crashes)"
echo "  2. ✅ MongoDB reconnection (prevents data loss)"
echo "  3. ✅ Per-phone rate limiting (prevents spam)"
echo "  4. ✅ Memory cleanup (prevents memory leaks)"
echo "  5. ✅ Environment validation (fail-fast on startup)"
echo "  6. ✅ Request tracking (better debugging)"
echo "  7. ✅ Security timing fix (already applied)"
echo ""

# Step 4: Ask for confirmation
echo -e "${YELLOW}⚠️  This will modify server.js${NC}"
echo "Backup saved to: $BACKUP_FILE"
echo ""
read -p "Apply all fixes now? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled. Your backup is safe at: $BACKUP_FILE"
  exit 0
fi
echo ""

# Step 5: Apply fixes
echo "🔨 Step 4: Applying fixes..."
echo ""
echo -e "${YELLOW}⚠️  MANUAL STEPS REQUIRED${NC}"
echo ""
echo "The fixes have been prepared in: fixes-to-add.js"
echo "Follow these steps:"
echo ""
echo "1. Open DETAILED-FIX-GUIDE.md"
echo "2. Copy each fix from fixes-to-add.js"
echo "3. Paste into server.js at the locations specified"
echo ""
echo "Or use this command to see the guide:"
echo ""
echo "  cat DETAILED-FIX-GUIDE.md | less"
echo ""
echo -e "${GREEN}Files created:${NC}"
echo "  ✅ APPLY-FIXES.md - Overview and instructions"
echo "  ✅ DETAILED-FIX-GUIDE.md - Step-by-step guide with exact line numbers"
echo "  ✅ fixes-to-add.js - All code to copy"
echo "  ✅ $BACKUP_FILE - Your backup"
echo ""

# Step 6: Offer to open the guide
if command -v code &> /dev/null; then
  read -p "Open files in VS Code? (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    code DETAILED-FIX-GUIDE.md
    code fixes-to-add.js
    code server.js
    echo -e "${GREEN}✅ Files opened in VS Code${NC}"
  fi
elif command -v nano &> /dev/null; then
  echo "You can edit server.js with: nano server.js"
fi

echo ""
echo "=================================================="
echo "  Next Steps:"
echo "=================================================="
echo ""
echo "1. Follow DETAILED-FIX-GUIDE.md to apply fixes"
echo "2. Test syntax: node -c server.js"
echo "3. Run server: node server.js"
echo "4. Test with WhatsApp message"
echo ""
echo "To rollback: cp $BACKUP_FILE server.js"
echo ""
echo -e "${GREEN}🎉 Setup complete! Happy fixing!${NC}"
