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

  // ═══════ Catalogue / Specialty categories — route to PDF catalogs ═══════
  //
  // These categories don't have MongoDB images (one image per SKU), but they
  // DO have curated PDF catalogs that customers can browse. Each entry below
  // has `pdfCatalog: '<KEY>'` which maps to the env var PDF_CATALOG_<KEY>.
  // The bot sends the PDF as an attachment + a short message.
  //
  // To upgrade a category from PDF-only to per-SKU images: upload photos to
  // MongoDB Product collection, then flip hasImages→true and add mongoSearch.

  'mirrors': {
    patterns: [/\b(mirror|mirrors|wall mirror|wall mirrors)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'PRODUCTS',
    pdfCaption: "Here's our full cork products catalog — mirror designs included! 🪞"
  },
  'wall_panels': {
    patterns: [/\b(wall panel|wall panels|cork panel|cork panels|acoustic panel|acoustic panels|decorative panel)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'ELEVATION',
    pdfCaption: "Here's our Elevation e-catalog featuring cork wall panels and premium decor! ✨"
  },
  'wall_frames': {
    patterns: [/\b(wall frame|wall frames|cork wall frame)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'PRODUCTS',
    pdfCaption: "Here's our cork products catalog — wall frames included! 🌿"
  },
  'bar_caddies': {
    patterns: [/\b(caddy|caddies|bar caddy|bar caddies)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — bar caddies and more! 🍽️"
  },
  'menu_bill_folders': {
    patterns: [/\b(menu folder|menu folders|bill folder|bill folders|menu cover|menu & bill)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — menu and bill folders included! 🍽️"
  },
  'lamps': {
    patterns: [/\b(lamps?|hanging light|hanging lights|pendant light|pendant lights)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — cork lamps and hanging lights included! 🏮"
  },
  'stools': {
    patterns: [/\bstools?\b|\bcork stool\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — cork stools included! 🪑"
  },
  'napkin_rings': {
    patterns: [/\b(napkin rings?|cork napkin ring)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — napkin rings included! 🍽️"
  },
  'tissue': {
    patterns: [/\b(tissue box|tissue boxes|tissue holder|tissue holders|tissue paper)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — tissue boxes and holders included! 🌿"
  },
  'room_tags': {
    patterns: [/\b(room tag|room tags|door tag|door tags|do not disturb)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — room tags (do-not-disturb / housekeeping / etc.) included! 🛎️"
  },
  'menu_scanners': {
    patterns: [/\b(menu scanner|menu scanners|qr scanner|qr stand|qr holder)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — QR menu scanners included! 📱"
  },
  'ice_chillers': {
    patterns: [/\b(ice chiller|ice chillers|ice bucket|ice buckets|wine chiller|wine chillers|bottle chiller)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'HORECA',
    pdfCaption: "Here's our HORECA catalog — ice and wine chillers included! 🍷"
  },
  'soil_planters': {
    patterns: [/\b(soil planter|soil planters|earthen planter|earthen planters)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'PLANTERS',
    pdfCaption: "Here's our cork planters catalog — soil planters included! 🌱"
  },
  'trophies': {
    patterns: [/\b(trophy|trophies|award|awards|recognition|memento)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'TROPHY',
    pdfCaption: "Here's our cork trophy catalog! 🏆"
  },
  // Yoga catalog — both image and PDF available
  'yoga_catalog': {
    patterns: [/\b(yoga catalog|yoga catalogue|yoga brochure|yoga pdf|yoga collection)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'YOGA',
    pdfCaption: "Here's our cork yoga essentials catalog! 🧘"
  },
  // Premium / Elevation line
  'premium_collection': {
    patterns: [/\b(premium catalog|premium catalogue|elevation catalog|elevation catalogue|luxury collection|executive collection)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'ELEVATION',
    pdfCaption: "Here's our Elevation e-catalog — premium cork line! ✨"
  },
  // Minimalist line
  'minimalist_collection': {
    patterns: [/\b(minimalist catalog|minimal catalog|essential catalog|basic collection)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'MINIMALIST',
    pdfCaption: "Here's our Minimalist e-catalog! 🌿"
  },
  // Combos
  'combos_catalog': {
    patterns: [/\b(combo catalog|combo catalogue|gifting combo|combo brochure|gifting combos)\b/i],
    mongoSearch: null,
    hasImages: false,
    pdfCatalog: 'COMBOS',
    pdfCaption: "Here's our cork gifting combos catalog! 🎁"
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
  // PDF-specific catalog requests checked first (more specific intent)
  'yoga_catalog',
  'premium_collection',
  'minimalist_collection',
  'combos_catalog',

  // Specific multi-word categories before single-word ones
  'photo_frames',
  'wall_frames',
  'wall_panels',
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
