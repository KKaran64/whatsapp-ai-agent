// Intent Extractor — Path B (v60)
//
// Scans the customer's latest message + recent conversation context for the
// four pieces the quote engine needs:
//   - productQuery: a product name/SKU keyword
//   - quantity: integer
//   - customerType: 'end_consumer' | 'reseller' | null (unknown)
//   - branding: 'single-color' | 'pad-printing' | 'multi-color' | 'laser' | null
//
// Returns null if NOT a pricing-intent message at all (just a greeting, a
// follow-up question, etc.). The caller checks for this and skips engine
// invocation when intent is null.

// ─────────────────────────────────────────────────────────────────────
// Pricing-intent detection (does this message even want a quote?)
// ─────────────────────────────────────────────────────────────────────
const PRICING_INTENT_PATTERNS = [
  /\b(price|cost|quote|rate|how much|kya rate|kitne ka)\b/i,
  /\b\d+\s+(pcs|piece|pieces|nos|qty|quantity|mats|diaries|coasters|pens|bags|frames|trays|holders|planters|trophies|caddy|caddies|pouches|wallets|tablemats|trivets|bottles|clocks|sleeves|organizers|boxes|bricks|balls|rollers)\b/i,
  /\bsend (the )?(invoice|pi|quote|bill|proforma)\b/i,
  /\b(?:i\s+)?(?:need|want|require)\b/i,    // "I need" OR bare "need"
  /\b(?:i'?m\s+)?looking for\b/i,            // "I'm looking for" OR "looking for"
  /\binterested in\b/i,
  /^\s*\d+\s*$/i                              // bare number "100" as a reply
];

function hasPricingIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return PRICING_INTENT_PATTERNS.some(re => re.test(message));
}

// ─────────────────────────────────────────────────────────────────────
// Customer type signals (same list as RULE F in the prompt)
// ─────────────────────────────────────────────────────────────────────
const END_CONSUMER_PATTERNS = [
  /\bfor (my|our) hotel\b/i,
  /\bfor (my|our) restaurant\b/i,
  /\bfor (my|our) cafe\b/i,
  /\bfor (my|our) office\b/i,
  /\bfor (my|our) company\b/i,
  /\bfor (my|our) (yoga )?studio\b/i,
  /\bfor (our|my) employees\b/i,
  /\bfor (our|my) company event\b/i,
  /\bfor (our|my) team\b/i,
  /\bfor (our|my) store opening\b/i,
  /\bfor (our|my) launch\b/i,
  /\bpersonal use\b/i,
  /\bfor myself\b/i,
  /\bcorporate gift(ing)?\b/i,
  // "I'm opening / I want to open / need to open / planning to open a studio/hotel/..."
  /\b(open(?:ing)?|opening|planning to open|going to open|setting up|starting)\s+(?:a |an |my |our )?(?:yoga |coffee |new )?(?:studio|restaurant|hotel|cafe|shop|store|outlet|business)\b/i,
  /\bopen(?:ing)? (?:up )?(?:a |an |my |our )?(?:yoga )?(?:studio|restaurant|hotel|cafe|shop|store)\b/i,
  /\bneed (?:these |it |them )?(?:for|in) (?:my|our|a) (?:yoga )?(?:studio|restaurant|hotel|cafe|shop|store|office|company)\b/i
];

const RESELLER_PATTERNS = [
  /\bi(?:'m| am)? a reseller\b/i,
  /\bi sell to (my|our) customers\b/i,
  /\bfor (my|our) shop\b/i,
  /\bfor (my|our) gifting (company|business)\b/i,
  /\bi(?:'m| am)? a distributor\b/i,
  /\bto re-?sell\b/i,
  /\bfor re-?sell(ing)?\b/i,
  /\bfor re-?sale\b/i,        // "for resale"
  /\bre-?sale\b/i,             // bare "resale"
  /\bwholesale\b/i,
  /\bi run a gifting business\b/i,
  /\bi supply to corporates\b/i,
  /\bb2b distribution\b/i,
  /\bneed for re-?sell(ing)?\b/i
];

function detectCustomerType(texts) {
  const joined = texts.filter(Boolean).join(' \n ');
  if (RESELLER_PATTERNS.some(re => re.test(joined))) return 'reseller';
  if (END_CONSUMER_PATTERNS.some(re => re.test(joined))) return 'end_consumer';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Quantity detection
// ─────────────────────────────────────────────────────────────────────
function detectQuantity(text) {
  if (!text) return null;
  // Look for: <number> <product-noun> OR <number> pcs/pieces/nos/qty
  const patterns = [
    /\b(\d{1,5})\s*(?:pcs|pieces|nos|qty|quantity|mats|diaries|coasters|pens|bags|frames|trays|holders|planters|trophies|caddies|caddy|pouches|wallets|tablemats|trivets|bottles|clocks|sleeves|organizers|boxes|bricks|balls|rollers)\b/i,
    /\bneed\s+(\d{1,5})\b/i,
    /\bwant\s+(\d{1,5})\b/i,
    /\bfor\s+(\d{1,5})\b/i,
    /\b(\d{1,5})\s+(?:cork|diaries|diary)/i,
    /^(\d{1,5})$/  // bare number message like "100"
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 99999) return n;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Branding detection
// ─────────────────────────────────────────────────────────────────────
const BRANDING_PATTERNS = {
  'laser':         /\blaser (engraving|marking|mark|engrav)\b/i,
  'multi-color':   /\b(multi[\s-]?color|multicolor|multi colour|multicolour|uv|dtf|uv\/dtf|full color)\b/i,
  'pad-printing':  /\bpad print(ing)?\b/i,
  'single-color':  /\b(single[\s-]?color|single colour|one color|screen print(ing)?|with logo)\b/i  // "with logo" defaults to single-color
};

function detectBranding(texts) {
  const joined = texts.filter(Boolean).join(' \n ');
  // Check in priority order — more specific first
  if (BRANDING_PATTERNS.laser.test(joined)) return 'laser';
  if (BRANDING_PATTERNS['multi-color'].test(joined)) return 'multi-color';
  if (BRANDING_PATTERNS['pad-printing'].test(joined)) return 'pad-printing';
  if (BRANDING_PATTERNS['single-color'].test(joined)) return 'single-color';
  // Customer said "no branding"
  if (/\b(no|without)\s+(logo|branding|printing|customization)\b/i.test(joined)) return null;
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Product query extraction
// ─────────────────────────────────────────────────────────────────────
// Strategy: find the longest substring of the message that looks like a product name.
// We let the engine's matcher decide which catalog SKU it maps to.

const PRODUCT_NOUNS = [
  'diary', 'diaries', 'a5', 'a6', 'executive diary', 'ceo diary', 'ecoelite',
  'coaster', 'coasters', 'round coaster', 'square coaster',
  'planter', 'planters', 'test tube planter', 'casa planter', 'table top planter',
  'bag', 'bags', 'sleeve', 'sleeves', 'laptop bag', 'jet case', 'nomad vault',
  'pen', 'pens', 'cork pen', 'metal pen',
  'frame', 'frames', 'photo frame',
  'tray', 'trays', 'serving tray',
  'holder', 'holders', 'tea light holder', 'pen holder',
  'bottle', 'bottles', 'cork bottle',
  'trivet', 'trivets',
  'tablemat', 'tablemats',
  'clock', 'clocks', 'table clock',
  'trophy', 'trophies', 'cork trophy',
  'mat', 'mats', 'yoga mat',
  'pouch', 'pouches',
  'wallet', 'wallets',
  'box', 'boxes', 'gift box',
  'brick', 'bricks', 'yoga brick',
  'ball', 'balls', 'yoga ball',
  'roller', 'rollers', 'yoga roller',
  'caddy', 'caddies', 'bar caddy', 'bill folder', 'menu folder',
  'organizer', 'organizers', 'desk organizer', 'travel organizer',
  'card holder', 'passport holder', 'wallet'
];

// Try to extract product from message (look for SKU codes too like "9C-DR1")
function detectProductQuery(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  // SKU code direct: "9C-DR1", "9C251001"
  const skuMatch = text.match(/\b(9C[-\d][A-Z0-9-]{2,10})\b/i);
  if (skuMatch) return skuMatch[1];

  // v60.2: Specific catalog SKU names that customers commonly say in full.
  // These multi-word names must be preserved entirely so the quote engine
  // can find an exact catalog match — not stripped down to just "organizer"
  // or "planter" (which would return multiple matches).
  // Check BEFORE generic noun matching.
  const NAMED_PRODUCTS = [
    // Diaries
    'ecodesk diary a5', 'ecodesk diary a6', 'executive diary', 'ceo diary',
    'ecoelite diary', 'organizer cum diary', 'pro organizer linea',
    'spiral organizer', 'terra organizer',
    // Planters
    'casa planter', 'fridge magnet planter', 'ember planter', 'natural planter',
    'donut planter', 'cork belly planter', 'pitcher bloom planter', 'oval oasis planter',
    'cylindrical planter', 'rectangular test tube planter', 'tri edge planter',
    'loop planter', 'round test tube planter', 'tapered test tube planter',
    'brick test tube planter', 'box print planter', 'bohemian print planter',
    'diamond planter', 'feather planter', 'olive planter', 'chococchip planter',
    'abstract planter', 'striped planter', 'aqua planter', 'flat planter',
    'triplanter', 'four bloom planter', 'three bloom planter',
    // Bags
    'nomad vault', 'pro laptop bag', 'jet case', 'neo hues bag', 'terra bag',
    'ocean mist bag', 'laptop bag granco', 'laptop bag linea', 'laptop bag premia',
    'printed laptop bag', 'conference folder',
    // Trays
    'olive tray', 'striped tray', 'red assiago tray', 'abstract tray', 'natural tray',
    'small round tray', 'shot glasses tray',
    // Holders, etc
    'pen station', 'pen holder', 'round pen holder', 'cork belly tea light holder',
    'cork bark tea light holder', 'cork square 4-in-1 tea light holder',
    // Coasters
    '5 mm round coaster', '5 mm square coaster', 'bread coaster', 'cork belly coaster',
    'cork earthy coaster', 'cork coffee coaster', 'leaf shape coaster',
    'box uv printed coaster', 'diamond uv printed coaster',
    // Caddies (numeric variants matched by modifier branch below)
    'bar caddy', 'caddy',
    // Other
    'cork desk organizer', 'cork ipad desk organizer', 'cork pro desk organizer',
    'cork linear desk organizer', 'cork terra desk organizer tray',
    'cork signature desk organizer', 'cork desktop organizer tray',
    'cork stationery organizer', 'cork elite desk organizer tray',
    'compact pen & mobile holder', 'pen & card holder'
  ];
  // Sort longest first so multi-word names beat shorter ones
  const sortedNamed = NAMED_PRODUCTS.sort((a, b) => b.length - a.length);
  for (const name of sortedNamed) {
    const namePattern = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i');
    if (namePattern.test(lower)) {
      return name;
    }
  }

  // Product + numeric modifier — "caddy no 17", "trophy 5", "diary a5".
  // Only nouns that customers typically pair with a model number/code.
  const modifierMatch = lower.match(/\b(caddy|caddies|diary|diaries|trophy|trophies)\b\s+(?:no\.?\s*)?([a-z]?\d{1,4})\b/i);
  if (modifierMatch) {
    // Treat group 2 as a model identifier and stick it after the noun
    return `${modifierMatch[1]} ${modifierMatch[2]}`;
  }

  // "diary a5" / "a5 diary" — letter+digit modifier before/after noun
  const letterDigitMatch = lower.match(/\b(diary|diaries|trophy)\s+([a-z]\d)\b|\b([a-z]\d)\s+(diary|diaries|trophy)\b/i);
  if (letterDigitMatch) {
    const noun = letterDigitMatch[1] || letterDigitMatch[4];
    const mod = letterDigitMatch[2] || letterDigitMatch[3];
    return `${mod} ${noun}`;
  }

  // Longest-noun-first matching — "yoga mat" wins over "mat", "passport holder"
  // wins over "holder", etc. This handles compound product names correctly.
  let bestMatch = null;
  const sortedNouns = [...PRODUCT_NOUNS].sort((a, b) => b.length - a.length);
  for (const noun of sortedNouns) {
    if (new RegExp('\\b' + noun.replace(/\s+/g, '\\s+') + '\\b', 'i').test(lower)) {
      bestMatch = noun;
      break;
    }
  }
  return bestMatch;
}

// ─────────────────────────────────────────────────────────────────────
// Main extraction
// ─────────────────────────────────────────────────────────────────────
// Args:
//   currentMessage: the customer's most recent text
//   contextMessages: array of recent {role, content} from conversation
function extractIntent(currentMessage, contextMessages = []) {
  if (!currentMessage || typeof currentMessage !== 'string') return null;

  const recentTexts = [
    ...contextMessages.slice(-10).map(m => m.content || ''),
    currentMessage
  ];
  const recentCustomerOnly = [
    ...contextMessages.filter(m => m.role === 'user').slice(-5).map(m => m.content || ''),
    currentMessage
  ];

  // Quick exit: if no pricing intent in current OR recent customer messages,
  // don't bother. Bot is just doing qualifying / chitchat.
  const hasIntentNow = hasPricingIntent(currentMessage);
  const hasIntentRecently = recentCustomerOnly.slice(-3).some(t => hasPricingIntent(t));
  if (!hasIntentNow && !hasIntentRecently) return null;

  // Product query: try current message first, then progressively expand the
  // customer-only lookback. The yoga studio bug had product mentioned 5 turns
  // back ("do I have yoga mat?") then customer just said "I need 40".
  const productQuery =
    detectProductQuery(currentMessage)
    || detectProductQuery(recentCustomerOnly.slice(-3).join(' '))
    || detectProductQuery(recentCustomerOnly.slice(-6).join(' '));

  return {
    productQuery,
    quantity: detectQuantity(currentMessage) || detectQuantity(recentCustomerOnly.slice(-3).join(' ')),
    customerType: detectCustomerType(recentCustomerOnly),
    branding: detectBranding(recentCustomerOnly)
  };
}

module.exports = {
  extractIntent,
  hasPricingIntent,
  detectQuantity,
  detectCustomerType,
  detectBranding,
  detectProductQuery
};
