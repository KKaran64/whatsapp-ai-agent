// Enhanced Product Enrichment v2 - Fixes test failures
const fs = require('fs');
const data = require('./products-data.json');

console.log('🔧 Enhanced Product Enrichment v2...\n');

// Helper function to generate comprehensive tags
function generateEnhancedTags(name, category) {
  const tags = [];
  const nameLower = name.toLowerCase();
  const catLower = category.toLowerCase();

  // === PRODUCT NAME ELEMENTS (Add specific words from product name) ===
  if (nameLower.includes('set')) tags.push('set', 'coaster set', 'gift set');
  if (nameLower.match(/\ba5\b/)) tags.push('a5', 'a5 diary', 'medium diary');
  if (nameLower.match(/\ba6\b/)) tags.push('a6', 'a6 diary', 'small diary', 'pocket diary');
  if (nameLower.includes('hexagon')) tags.push('hexagon', 'hexagonal', 'hexagon coaster', '6-sided');
  if (nameLower.includes('heart')) tags.push('heart', 'heart shape', 'heart coaster');
  if (nameLower.includes('leaf')) tags.push('leaf', 'leaf pattern', 'leaf coaster');

  // === SIZE TAGS ===
  if (nameLower.match(/\bsmall\b/)) tags.push('small', 'compact', 'mini', 'small size');
  if (nameLower.match(/\blarge\b/)) tags.push('large', 'big', 'jumbo', 'large size');
  if (nameLower.match(/\bmedium\b/)) tags.push('medium', 'mid-size', 'medium size');

  // === MATERIAL TAGS ===
  tags.push('cork', 'eco-friendly', 'sustainable', 'natural'); // All products are cork
  if (nameLower.includes('canvas')) tags.push('canvas', 'fabric');
  if (nameLower.includes('leather')) tags.push('leather', 'vegan leather');

  // === SHAPE TAGS ===
  if (nameLower.match(/\bround\b/)) tags.push('round', 'circular', 'round shape');
  if (nameLower.match(/\bsquare\b/)) tags.push('square', 'rectangular', 'square shape');
  if (nameLower.match(/\boval\b/)) tags.push('oval', 'elliptical');
  if (nameLower.includes('cylindrical')) tags.push('cylindrical', 'cylinder', 'round');

  // === COASTERS ===
  if (catLower.includes('coaster')) {
    tags.push('coaster', 'coasters', 'drink coaster', 'drink coasters', 'table protection', 'home decor', 'tableware');
  }

  // === DIARIES ===
  if (catLower.includes('diar')) {
    tags.push('diary', 'diaries', 'notebook', 'notebooks', 'journal', 'journals', 'planner', 'planners', 'writing', 'stationery');
  }

  // === DESK ORGANIZERS ===
  if (catLower.includes('desk') || catLower.includes('organiz')) {
    tags.push('desk', 'desk organizer', 'office', 'office organizer', 'storage', 'stationery', 'workspace', 'organization');
    if (nameLower.includes('pen')) tags.push('pen', 'pen holder', 'pencil', 'pencil holder', 'writing');
    if (nameLower.includes('card')) tags.push('card', 'card holder', 'business card', 'cards');
  }

  // === PLANTERS ===
  if (catLower.includes('planter')) {
    tags.push('planter', 'planters', 'pot', 'pots', 'plants', 'flowers', 'home decor', 'garden', 'gardening');
    if (catLower.includes('test tube')) tags.push('test tube', 'test-tube', 'unique', 'decorative');
    if (catLower.includes('table top')) tags.push('table top', 'tabletop', 'desktop', 'small planter');
    if (nameLower.includes('magnet')) tags.push('magnet', 'fridge magnet', 'refrigerator');
  }

  // === BAGS & LAPTOP ===
  if (catLower.includes('bag') || catLower.includes('laptop')) {
    tags.push('bag', 'bags', 'carry', 'travel');
    if (catLower.includes('laptop')) tags.push('laptop', 'laptop bag', 'laptop sleeve', 'laptop case', 'computer', 'notebook');
    if (catLower.includes('purse') || nameLower.includes('clutch') || nameLower.includes('wallet')) {
      tags.push('wallet', 'wallets', 'purse', 'purses', 'money', 'cards', 'accessory');
    }
    if (nameLower.includes('clutch')) tags.push('clutch', 'handbag', 'evening bag');
    if (nameLower.includes('sling')) tags.push('sling', 'sling bag', 'shoulder bag');
    if (nameLower.includes('tote')) tags.push('tote', 'tote bag', 'shopping bag');
  }

  // === TRAVEL ORGANIZERS ===
  if (catLower.includes('travel')) {
    tags.push('travel', 'travel organizer', 'travel accessories', 'passport', 'organizer', 'cards', 'documents');
    if (nameLower.includes('passport')) tags.push('passport', 'passport holder', 'travel documents');
    if (nameLower.includes('wallet') || nameLower.includes('card')) {
      tags.push('wallet', 'travel wallet', 'card holder', 'cards');
    }
  }

  // === PHOTO FRAMES ===
  if (catLower.includes('frame')) {
    tags.push('photo frame', 'photo frames', 'picture frame', 'picture frames', 'photoframe', 'wall decor', 'display', 'photography');
  }

  // === TRAYS ===
  if (catLower.includes('tray')) {
    tags.push('tray', 'trays', 'serving tray', 'serving trays', 'table', 'dining', 'decor', 'tableware');
  }

  // === TEA LIGHT HOLDERS ===
  if (catLower.includes('tea light') || catLower.includes('candle')) {
    tags.push('tea light', 'tea lights', 'tealight', 'tealights', 'candle', 'candles', 'candle holder', 'candle holders', 'home decor', 'lighting', 'ambiance');
  }

  // === BOTTLES ===
  if (catLower.includes('bottle')) {
    tags.push('bottle', 'bottles', 'water bottle', 'water bottles', 'drink', 'beverage', 'hydration');
  }

  // === YOGA MATS ===
  if (catLower.includes('yoga')) {
    tags.push('yoga', 'yoga mat', 'yoga mats', 'exercise', 'exercise mat', 'fitness', 'fitness mat', 'mat', 'mats', 'workout', 'workout mat');
  }

  // === TABLE MATS ===
  if (catLower.includes('tablemat')) {
    tags.push('table mat', 'table mats', 'tablemat', 'tablemats', 'placemat', 'placemats', 'dining', 'dining mat', 'tableware');
  }

  // === TRIVETS / HOT PLATES ===
  if (catLower.includes('trivet') || catLower.includes('hot plate')) {
    tags.push('trivet', 'trivets', 'hot plate', 'hot plates', 'pot holder', 'pot holders', 'kitchen', 'heat protection');
  }

  // === CLOCKS ===
  if (catLower.includes('clock')) {
    tags.push('clock', 'clocks', 'time', 'table clock', 'desk clock', 'wall clock', 'timepiece');
  }

  // === GIFT BOXES ===
  if (catLower.includes('gift') || catLower.includes('box')) {
    tags.push('gift', 'gift box', 'gift boxes', 'present', 'packaging', 'gifting', 'box', 'boxes');
  }

  // === GAMES ===
  if (catLower.includes('game')) {
    tags.push('game', 'games', 'fun', 'entertainment', 'play');
  }

  // === SHELF DECOR ===
  if (catLower.includes('shelf') || catLower.includes('decor')) {
    tags.push('shelf', 'shelf decor', 'decoration', 'decorative', 'home decor', 'display');
  }

  // === USE CASES ===
  if (nameLower.includes('mobile') || nameLower.includes('phone')) tags.push('mobile', 'phone', 'smartphone', 'cell phone');
  if (nameLower.includes('ipad') || nameLower.includes('tablet')) tags.push('ipad', 'tablet', 'device');

  // Remove duplicates and return
  return [...new Set(tags)].join(' ');
}

// Enhanced aliases generation
function generateEnhancedAliases(name, category) {
  const aliases = [];
  const nameLower = name.toLowerCase();

  // Remove Cork/C0RK prefix
  const cleanName = name.replace(/^CORK\s+/i, '').replace(/^C0RK\s+/i, '');
  if (cleanName !== name) aliases.push(cleanName.toLowerCase());

  // Common misspellings
  const variations = {
    'coaster': ['costers', 'coster', 'coater'],
    'diary': ['diry', 'diaries', 'dairy'],
    'organizer': ['organiser', 'organizor'],
    'planter': ['planters', 'planter pot'],
    'wallet': ['wallets', 'purse'],
    'laptop': ['lap top', 'notebook'],
    'calender': ['calendar', 'calendars'],
    'holder': ['holdr', 'stand'],
    'table': ['tabel'],
  };

  Object.entries(variations).forEach(([word, vars]) => {
    if (nameLower.includes(word)) {
      vars.forEach(v => aliases.push(v));
    }
  });

  return [...new Set(aliases)].join(' ');
}

// Re-enrich all products
let enriched = 0;
data.forEach((product, index) => {
  const aliases = generateEnhancedAliases(product.name, product.category);
  const tags = generateEnhancedTags(product.name, product.category);

  product.aliases = aliases;
  product.tags = tags;
  enriched++;

  if (enriched % 50 === 0) {
    console.log(`✅ Enhanced ${enriched} products...`);
  }
});

// Save
fs.writeFileSync(
  '/Users/kkaran/whatsapp-claude-bridge/scripts/products-data.json',
  JSON.stringify(data, null, 2)
);

console.log(`\n🎉 Enhanced enrichment complete!`);
console.log(`   Total products: ${data.length}`);
console.log(`   All products now have comprehensive tags!\n`);

// Show samples
console.log('📝 Sample enhanced products:');
const samples = [
  data.find(p => p.name.includes('SET OF 4')),
  data.find(p => p.name.includes('A5')),
  data.find(p => p.name.includes('HEXAGON')),
  data.find(p => p.name.includes('TABLEMAT')),
  data.find(p => p.name.includes('TEA LIGHT')),
];

samples.forEach(p => {
  if (p) {
    console.log(`\n${p.productId}: ${p.name}`);
    console.log(`   Tags: ${p.tags.substring(0, 80)}...`);
  }
});
