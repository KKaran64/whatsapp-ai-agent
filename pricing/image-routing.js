// Comprehensive Image Routing — v60
//
// Single source of truth for: "what category is the customer asking about,
// and do we have images for it?"
//
// Maps every catalog category (from data/pricing.json) to either:
//   - A MongoDB search term (so findProductsByCategory can fetch images)
//   - null (meaning we don't have images yet — route to graceful fallback)
//
// When you upload product photos for a new category, just flip its
// `hasImages: false` → `true` and add a `mongoSearch` term. No regex
// rewriting needed elsewhere.

// ─────────────────────────────────────────────────────────────────────
// All catalog categories, with patterns + MongoDB routing
// ─────────────────────────────────────────────────────────────────────
const CATEGORY_DEFINITIONS = {

  // ═══════ HORECA categories (all have MongoDB images) ═══════

  'coasters': {
    patterns: [/\b(coaster|coasters|coaster collection)\b/i],
    mongoSearch: 'COASTER',
    hasImages: true
  },
  'diaries': {
    patterns: [/\b(diary|diaries|notebook|notebooks|journal|journals)\b/i],
    mongoSearch: 'DIAR',  // matches C0RK DIARIES (typo) + CORK DIARIES
    hasImages: true
  },
  'desk_accessories': {
    patterns: [/\b(desk\b|desktop|organizers?|pen holder|pencil holder|catchall|trinket tray|stationery|mouse ?pad|mouse?pads)\b/i],
    mongoSearch: 'DESK',  // matches C0RK DESKTOP ACCESSORIES + CORK DESKTOP ACCESSORIES
    hasImages: true
  },
  'bags_purses': {
    patterns: [/\b(handbag|clutch|tote|purse|sling)\b/i],
    mongoSearch: 'BAG',
    hasImages: true
  },
  'laptop_bags': {
    patterns: [/\b(laptop bag|laptop sleeve|laptop case|conference folder|jet case|nomad vault)\b/i],
    mongoSearch: 'LAPTOP',
    hasImages: true
  },
  'travel_organizers': {
    patterns: [/\b(travel organizer|passport holder|card holder|card stacker|cork & canvas|wallet|wallets)\b/i],
    mongoSearch: 'TRAVEL',
    hasImages: true
  },
  'bottles': {
    patterns: [/\b(bottle|bottles|water bottle|cork bottle)\b/i],
    mongoSearch: 'BOTTLE',
    hasImages: true
  },
  'photo_frames': {
    patterns: [/\b(photo frame|photo frames|picture frame|picture frames|cork frame)\b/i],
    mongoSearch: 'PHOTO FRAME',
    hasImages: true
  },
  'gift_boxes': {
    patterns: [/\b(gift box|gift boxes|wine box|wine boxes|cork box)\b/i],
    mongoSearch: 'GIFT BOX',
    hasImages: true
  },
  'planters_test_tube': {
    patterns: [/\b(test tube planters?|testtube planters?|flask planters?|beaker planters?|bloom planters?)\b/i],
    mongoSearch: 'TEST TUBE PLANTER',
    hasImages: true
  },
  'planters_table_top': {
    patterns: [/\b(table top planters?|tabletop planters?|table planters?)\b/i],
    mongoSearch: 'TABLE TOP PLANTER',
    hasImages: true
  },
  'planters_general': {
    patterns: [/\b(planters?|pots?|succulent|fridge magnet planter|wall mounted planter)\b/i],
    mongoSearch: 'PLANTER',
    hasImages: true
  },
  'serving_trays': {
    patterns: [/\b(serving tray|decor tray|jars with tray|shot glasses tray)\b/i],
    mongoSearch: 'TRAY',
    hasImages: true
  },
  'shelf_decor': {
    patterns: [/\b(shelf decor|shelf decoration|wall decor)\b/i],
    mongoSearch: 'SHELF DECOR',
    hasImages: true
  },
  'table_clocks': {
    patterns: [/\b(table clock|clocks?|cork clock)\b/i],
    mongoSearch: 'CLOCK',
    hasImages: true
  },
  'tablemats': {
    patterns: [/\b(tablemats?|table mats?|placemats?)\b/i],
    mongoSearch: 'TABLEMAT',
    hasImages: true
  },
  'tea_light_holders': {
    patterns: [/\b(tea ?light|tea ?lights|tealights?|candle holder|candle holders|cork candle)\b/i],
    mongoSearch: 'TEA LIGHT',
    hasImages: true
  },
  'trivets': {
    patterns: [/\b(trivets?|hot ?plate|hot ?plates)\b/i],
    mongoSearch: 'TRIVET',
    hasImages: true
  },
  'fun_games': {
    patterns: [/\b(tic ?tac ?toe|fun game|cork game|board game)\b/i],
    mongoSearch: 'GAME',
    hasImages: true
  },
  'yoga': {
    patterns: [/\b(yoga|yoga mat|yoga mats|yoga brick|yoga roller|yoga ball|yoga accessor(y|ies))\b/i],
    mongoSearch: 'YOGA',
    hasImages: true
  },
  'general_trays': {
    patterns: [/\btrays?\b/i],  // Generic fallback for "tray" without serving/decor qualifier
    mongoSearch: 'TRAY',
    hasImages: true
  },
  'general_bags': {
    patterns: [/\bbags?\b/i],  // Generic fallback for "bag" without further qualifier
    mongoSearch: 'BAG',
    hasImages: true
  },

  // ═══════ Catalogue / Specialty categories (NO MongoDB images yet) ═══════
  // Upload photos to MongoDB and flip hasImages → true to enable.

  'mirrors': {
    patterns: [/\b(mirror|mirrors|wall mirror|wall mirrors)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "We have several cork mirror designs available — I don't have the photos handy right now. The team will share them with you shortly. Meanwhile, the prices I quoted are accurate."
  },
  'wall_frames': {
    patterns: [/\b(wall frame|wall frames|cork wall frame)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork wall frames come in multiple sizes. Photos aren't on hand right now — the team will share them shortly. Prices I quoted are accurate."
  },
  'bar_caddies': {
    patterns: [/\b(caddy|caddies|bar caddy|bar caddies)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork bar caddies come in multiple sizes (No.1 through No.20+). I don't have photos handy — the team can share them shortly. The pricing is in the HORECA catalog."
  },
  'menu_bill_folders': {
    patterns: [/\b(menu folder|menu folders|bill folder|bill folders|menu cover|menu & bill)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our menu and bill folders are HORECA staples. Photos aren't handy right now — the team will share them shortly."
  },
  'lamps': {
    patterns: [/\b(lamps?|hanging light|hanging lights|pendant light|pendant lights)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "We have cork lamps and hanging lights. I don't have photos on hand — the team can share them with you shortly."
  },
  'stools': {
    patterns: [/\bstools?\b|\bcork stool\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork stools are a HORECA seating option. Photos aren't handy right now — the team will share them shortly."
  },
  'napkin_rings': {
    patterns: [/\b(napkin rings?|cork napkin ring)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "We have cork napkin rings for table settings. Photos aren't handy — the team will share them shortly."
  },
  'tissue': {
    patterns: [/\b(tissue box|tissue boxes|tissue holder|tissue holders|tissue paper)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork tissue boxes and holders are stocked. Photos aren't handy right now — the team will share them shortly."
  },
  'room_tags': {
    patterns: [/\b(room tag|room tags|door tag|door tags|do not disturb)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork room tags (do-not-disturb / housekeeping / etc.) are HORECA staples. Photos aren't handy — the team will share them shortly."
  },
  'menu_scanners': {
    patterns: [/\b(menu scanner|menu scanners|qr scanner|qr stand|qr holder)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork QR menu scanners are available. Photos aren't handy — the team will share them shortly."
  },
  'ice_chillers': {
    patterns: [/\b(ice chiller|ice chillers|ice bucket|ice buckets|wine chiller|wine chillers|bottle chiller)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork ice/wine chillers are HORECA staples. Photos aren't handy right now — the team will share them shortly."
  },
  'soil_planters': {
    patterns: [/\b(soil planter|soil planters|earthen planter|earthen planters)\b/i],
    mongoSearch: null,
    hasImages: false,
    fallbackMessage: "Our cork soil planters are stocked. Photos aren't handy right now — the team will share them shortly."
  },
  'trophies': {
    patterns: [/\b(trophy|trophies|award|awards|recognition|memento)\b/i],
    mongoSearch: null,  // Trophies use PDF catalog (PDF_CATALOG_TROPHY)
    hasImages: false,
    fallbackMessage: "I'll share our cork trophy catalog with you — please give me a moment."
  },

  // ═══════ Catch-all generic patterns (lowest priority) ═══════

  'all': {
    patterns: [/\b(catalog|catalogue|all products|full range|variety|options|whole range|product range)\b/i],
    mongoSearch: '',  // empty = show variety
    hasImages: true
  }
};

// ─────────────────────────────────────────────────────────────────────
// Resolution order — more-specific patterns first, generic last
// ─────────────────────────────────────────────────────────────────────
const RESOLUTION_ORDER = [
  // Specific multi-word categories BEFORE single-word ones to avoid false
  // matches (e.g. "photo frame" must be checked before "frame")
  'photo_frames',
  'wall_frames',
  'laptop_bags',
  'travel_organizers',
  'serving_trays',
  'planters_test_tube',
  'planters_table_top',
  'tea_light_holders',
  'gift_boxes',
  'menu_bill_folders',
  'bar_caddies',
  'menu_scanners',
  'ice_chillers',
  'soil_planters',
  'napkin_rings',
  'room_tags',

  // Specific categories without sub-types
  'mirrors',
  'lamps',
  'stools',
  'tissue',
  'trophies',
  'yoga',

  // Specific main categories
  'coasters',
  'diaries',
  'desk_accessories',
  'bottles',
  'shelf_decor',
  'table_clocks',
  'tablemats',
  'trivets',
  'fun_games',
  'bags_purses',
  'planters_general',
  'general_trays',
  'general_bags',

  // Catch-all last
  'all'
];

// ─────────────────────────────────────────────────────────────────────
// Resolution function — given a user message, returns the matching category
// ─────────────────────────────────────────────────────────────────────
function resolveCategory(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') return null;
  for (const code of RESOLUTION_ORDER) {
    const def = CATEGORY_DEFINITIONS[code];
    if (!def) continue;
    if (def.patterns.some(p => p.test(userMessage))) {
      return { code, ...def };
    }
  }
  return null;
}

// Diagnostic: list all categories + their image availability
function categorySummary() {
  return Object.entries(CATEGORY_DEFINITIONS).map(([code, def]) => ({
    code,
    hasImages: def.hasImages,
    mongoSearch: def.mongoSearch
  }));
}

module.exports = {
  CATEGORY_DEFINITIONS,
  RESOLUTION_ORDER,
  resolveCategory,
  categorySummary
};
