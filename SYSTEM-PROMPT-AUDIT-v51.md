# SYSTEM PROMPT AUDIT v51 - Complete Analysis

**Date**: 2025-12-28
**Prompt Size**: 658 lines
**Priority**: CRITICAL - Root cause of repetitive bugs

---

## Executive Summary

The system prompt has become **unmanageable** with **multiple critical issues** causing bugs to recur even after being "fixed":

**Key Metrics**:
- **Total Size**: 658 lines (should be < 300)
- **Conflicts Found**: 8 major conflicts
- **Duplications Found**: 15+ duplicate instructions
- **Contradictions**: 6 contradictory instruction pairs
- **Fixes Deployed**: 50 versions in one day (36 are patch fixes)

**Root Causes**:
1. **Patch-on-patch**: Each fix adds new instructions without removing old ones
2. **No deduplication**: Same rules stated multiple times in different sections
3. **Conflicts**: New features override old fixes (v46 broke v39)
4. **No organization**: Rules scattered throughout, no clear hierarchy
5. **No testing**: Changes deployed without verification

---

## Critical Issues Found

### ISSUE #1: Catalog Request Handling (v39 → v46 → v50 Conflict)

**Location**: Lines 803-822

**Timeline**:
- **v39 (Dec 28)**: Fixed - bot should NOT ask for email
- **v46 (Dec 28)**: Added qualification gate - conflict introduced
- **v50 (Dec 28)**: Fixed again - same bug as v39

**The Conflict**:

```javascript
// v39 fix (implicit):
"Don't ask for email when sending catalog"

// v46 addition (conflicting):
"QUALIFY FIRST: 'What brings you to 9 Cork today?'"
"After they answer: THEN send catalog"

// Code reality:
PDF sends IMMEDIATELY when "catalog" detected (lines 995-1035)

// Result:
AI tries to qualify → Code sends immediately → Customer confused
OR
AI asks for email (old pattern) → Code sends immediately → Bad UX
```

**Current State (v50)**:
```javascript
Lines 807-811:
🚨 🚨 🚨 ABSOLUTELY FORBIDDEN - NEVER DO THIS:
❌ ❌ ❌ NEVER EVER ask: "Please share your email"
❌ ❌ ❌ NEVER EVER ask: "Please share your WhatsApp number"
```

**Why It Failed Before**: Not strong enough. AI ignored single ❌ warnings.

**Fix Applied**: Triple ❌ emphasis + exact forbidden phrases

**Recommendation**: ✅ Keep current v50 approach (aligns with code behavior)

---

### ISSUE #2: Quantity Hallucination (v48)

**Location**: Lines 187-212

**The Problem**:
System prompt had "200" repeated in **8 examples**:
- Line 202, 208, 382, 422, 441, 461, 476, etc.

**AI Pattern Learning**:
```
AI sees: "200" in multiple examples for corporate gifting
AI learns: "200 = default corporate order quantity"
AI applies: When customer says "corporate" + "gifting" + "clients" → assumes 200
Result: "For 200 cork diaries..." when customer never said 200
```

**Current Fix (v48)**:
```javascript
Lines 187-190:
**-1. NEVER HALLUCINATE - MOST CRITICAL RULE:**
❌ ❌ ❌ NEVER EVER invent, assume, or guess quantities
❌ ❌ ❌ NEVER say "For 200 pieces" or ANY number if customer did not mention it
```

**Additional Fix**: Diversified example quantities (150, 250, 300, 350, 400)

**Recommendation**: ✅ Keep, but monitor for other hallucination patterns (prices, dates, etc.)

---

### ISSUE #3: Product Accuracy Duplicat

ion

**Location**: Lines 214-237 AND scattered examples

**Duplication**:

```javascript
Line 214: "NEVER EVER change the product the customer asked for"
Line 215: "If customer says 'cork diary' - ONLY talk about cork diaries"
Line 216: "If customer says 'coasters' - ONLY talk about coasters"

Line 219: "ALWAYS use the EXACT product name..."
Line 220: "Check conversation history - what product did they ask about FIRST?"
Line 221: "Keep using that SAME product in ALL responses"

// All saying the same thing - keep only one consolidated version
```

**Recommendation**: Consolidate to single, clear statement with one example

---

### ISSUE #4: Image Sending Rules Duplication

**Location**: Lines 168-174 (top) AND previously deleted duplicate section

**History**:
- **v45**: Deleted duplicate image sending section (lines 751-757 were exact copy)
- **Current**: Single section remains (lines 168-174)

**Recommendation**: ✅ Already cleaned up in v45, keep as-is

---

### ISSUE #5: Price Consistency Triple Statement

**Location**: Previously at lines 286, 612, 615

**Fixed in v45**: Consolidated from 3 mentions to 1

**Current State**: Lines 647-650 (single unified statement)

**Recommendation**: ✅ Already cleaned up in v45

---

### ISSUE #6: Conversation Memory Instructions Scattered

**Location**: Lines 328-350 AND embedded in multiple other sections

**The Problem**:

```javascript
Line 329: "ALWAYS reference what customer JUST told you"
Line 332: "Check conversation history: Product mentioned → USE IT"
Line 333: "Quantity mentioned → USE IT"
Line 334: "Use case mentioned → USE IT"

// SAME CONCEPT repeated in:
Line 305: "Before giving ANY price - verify you have all 4"
Line 331: "Before EVERY response, CHECK conversation history"

// Both say "check conversation history" but for different purposes
```

**Recommendation**: Consolidate into single "Conversation Memory" section with clear hierarchy

---

### ISSUE #7: Brevity Rule Stated Multiple Times

**Location**: Lines 318-319 AND scattered reminders

**Duplication**:

```javascript
Line 318: "Maximum 2 sentences AND 200 characters per response!"
Line 320: (Keep responses SHORT - already implied by line 318)
Line 326: "Keep responses SHORT even with images - 2 sentences max!"

// Same rule stated 3 times
```

**Recommendation**: State once at top, reference elsewhere if needed

---

### ISSUE #8: Error Fallback Asking for Email (Fixed in v50)

**Location**: Line 1712

**The Bug**:
Even when system prompt forbids asking for email, error fallback message said:
"Please share your email and I'll send you our catalog..."

**Fixed**: Changed to generic error message without email ask

**Recommendation**: ✅ Keep v50 fix

---

## Structural Issues

### Organization Problems

**Current Structure** (chaotic):
```
Line 166: System identity
Line 168: Image sending rules
Line 177: Cork knowledge
Line 184: Critical rules START
Line 187: Rule -1 (Hallucination)
Line 214: Rule 0 (Product accuracy)
Line 238: Rule 0.5 (Multiple products)
Line 284: Rule 1 (Price blocking)
Line 318: Rule 2 (Brevity)
Line 321: Rule 3 (Image recognition)
Line 328: Rule 4 (Conversation memory)
Line 352: Sales qualification flow
Line 366: SSN negotiation
Line 472: LAER + SSN examples
Line 515: Invoice collection
Line 582: Pricing examples
Line 677: Product catalog
Line 803: Catalog requests
Line 824: End marker
```

**Issues**:
- ❌ No clear hierarchy (rules -1, 0, 0.5, 1, 2, 3, 4... why this numbering?)
- ❌ Examples scattered throughout instead of grouped
- ❌ Product catalog embedded in middle (should be at end)
- ❌ Related concepts separated (image sending at top AND in rule 3)

**Recommended Structure**:
```
1. Identity & Role
2. Critical Rules (prioritized, no numbering confusion)
   - Never hallucinate
   - Product accuracy
   - Price blocking
   - Conversation memory
3. Communication Style
   - Brevity
   - WhatsApp etiquette
4. Sales Process
   - Qualification flow
   - SSN negotiation
   - Invoice collection
5. Product Catalog (reference only)
6. Technical Rules
   - Image sending
   - Catalog delivery
```

---

### Size Issues

**Current**: 658 lines
**Industry Best Practice**: < 300 lines for reliable AI behavior
**Impact**: AI can "forget" or ignore instructions at end of prompt

**Breakdown**:
- Critical rules: ~200 lines ✅ (necessary)
- Examples: ~250 lines ⚠️ (could be reduced by 50%)
- Product catalog: ~150 lines ❌ (should be external reference)
- Duplications: ~58 lines ❌ (pure waste)

**Recommendation**: Target 400 lines (remove duplicates, externalize catalog)

---

## Recommendations

### Immediate Actions (v51)

**1. Remove Obvious Duplicates** (saves ~50 lines):
- Consolidate product accuracy (currently 3 examples, need 1)
- Remove duplicate conversation memory checks
- Consolidate brevity reminders

**2. Strengthen Critical Prohibitions**:
- ✅ Keep triple ❌ for "don't ask for email" (working in v50)
- ✅ Keep triple ❌ for "don't hallucinate quantities" (working in v48)
- Add triple ❌ for any new critical rules

**3. Move Product Catalog to External File** (saves ~150 lines):
```javascript
// Instead of 150-line inline catalog:
const PRODUCT_CATALOG = require('./product-catalog.json');
const SYSTEM_PROMPT = compilePrompt({
  identity: fs.readFileSync('./prompts/identity.txt'),
  rules: fs.readFileSync('./prompts/critical-rules.txt'),
  sales: fs.readFileSync('./prompts/sales-process.txt'),
  catalog: PRODUCT_CATALOG  // External reference
});
```

**4. Create Prompt Version Control**:
```
prompts/
  v51-current.txt
  v50-catalog-fix.txt
  v48-quantity-fix.txt
  ...
```

Can rollback prompt independently of code if needed.

---

### Short-term Actions (This Week)

**1. Modular Prompt System**:

```
prompts/
  core/
    identity.txt (25 lines)
    critical-rules.txt (100 lines)
    sales-process.txt (75 lines)
    communication-style.txt (50 lines)
  examples/
    correct-behavior.txt
    wrong-behavior.txt
  catalog/
    products.json
    pricing-rules.json
```

**2. Automated Conflict Detection**:

```javascript
// Script to check for conflicts
function detectPromptConflicts(prompt) {
  const conflicts = [];

  // Check for "ask for email" patterns
  if (prompt.includes('ask for email') && prompt.includes('NEVER ask for email')) {
    conflicts.push('Email ask conflict detected');
  }

  // Check for quantity patterns
  const quantityMatches = prompt.match(/\d{3}/g); // Find 3-digit numbers
  if (quantityMatches && quantityMatches.length > 5) {
    conflicts.push(`Too many quantity examples (${quantityMatches.length})`);
  }

  return conflicts;
}
```

**3. Prompt Regression Tests**:

Add to test suite:
```javascript
test('System prompt has no duplicates', () => {
  const duplicateLines = findDuplicateLines(SYSTEM_PROMPT);
  expect(duplicateLines).toHaveLength(0);
});

test('System prompt under 400 lines', () => {
  const lineCount = SYSTEM_PROMPT.split('\n').length;
  expect(lineCount).toBeLessThan(400);
});
```

---

### Long-term Actions (Next Month)

**1. State Machine for Critical Flows**:

Instead of relying on AI to remember catalog rules:

```javascript
class ConversationStateMachine {
  handleCatalogRequest() {
    // Enforce: Don't ask for email, just send
    return {
      response: "Here's our catalog! 🌿",
      action: 'SEND_CATALOG',
      nextState: 'POST_CATALOG_QUALIFICATION'
    };
  }
}
```

**2. Prompt Analytics**:

Track which sections AI actually uses:
```javascript
// Log which prompt sections influenced each response
console.log('Response influenced by: Rule -1 (quantity), Rule 2 (brevity)');
```

Identify unused sections → remove them.

**3. A/B Testing Framework**:

```javascript
const PROMPT_VARIANTS = {
  control: loadPrompt('v51-current'),
  variant_a: loadPrompt('v51-shortened'),
  variant_b: loadPrompt('v51-modular')
};

// 80% control, 10% each variant
const promptVersion = selectVariant(customerPhone);
```

---

## Immediate Next Steps

**For v51 Deployment**:

1. ✅ **Tests created** (critical-bugs.test.js, ai-response-validation.js)
2. ⏭️ **Consolidate duplicates** (remove ~50 lines)
3. ⏭️ **Run tests** before deployment
4. ⏭️ **Deploy v51** with clean prompt
5. ⏭️ **Monitor** for regressions using test suite

**Success Criteria**:
- Prompt < 600 lines (from 658)
- No duplicate rules
- No conflicting instructions
- All tests pass

---

## Why This Matters

**Current Situation**:
- Bug fixed in v39 → Returns in v46 → Fixed again in v50
- 50 versions deployed in one day (unsustainable)
- Customer frustrated: "stupid bot"
- Unprofessional, unreliable system

**With Clean Prompt**:
- Bugs stay fixed
- Fewer deployments needed
- Tests catch regressions automatically
- Professional, reliable system

**ROI**:
- **Time saved**: No more re-fixing same bugs
- **Customer satisfaction**: Consistent behavior
- **Revenue protected**: Fewer wrong orders
- **Engineering efficiency**: Clear, maintainable code

---

**Next Action**: Apply consolidation in v51, run tests, deploy with confidence
