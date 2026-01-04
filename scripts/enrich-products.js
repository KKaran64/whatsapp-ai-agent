// Enrich products with aliases and tags for better search
const fs = require('fs');
const data = require('./products-data.json');

console.log('🔧 Enriching products with aliases and keywords...\n');

// Helper function to generate aliases based on product name
function generateAliases(name, category) {
  const aliases = [];
  const nameLower = name.toLowerCase();

  // Add name without brand/material prefixes
  const cleanName = name
    .replace(/^CORK\s+/i, '')
    .replace(/^C0RK\s+/i, '')
    .replace(/^9C-\w+\s+/i, '');

  if (cleanName !== name) {
    aliases.push(cleanName.toLowerCase());
  }

  // Common misspellings and variations
  const variations = {
    'coaster': ['costers', 'coster', 'coater'],
    'diary': ['diry', 'diaries', 'dairy'],
    'organizer': ['organiser', 'organizor', 'organiser'],
    'planter': ['planters', 'planter pot'],
    'wallet': ['wallets', 'purse'],
    'laptop': ['lap top', 'notebook'],
    'photo frame': ['picture frame', 'photoframe', 'photo-frame'],
    'table': ['tabel', 'tabl'],
    'desk': ['deak', 'office'],
    'calender': ['calendar', 'calendars', 'calenders'],
    'holder': ['holdr', 'stand'],
    'bottle': ['bottel', 'water bottle'],
    'mat': ['mats', 'pad'],
    'tray': ['trays', 'serving tray'],
    'clutch': ['purse', 'handbag'],
    'sleeve': ['cover', 'case'],
    'pen': ['pencil', 'writing'],
  };

  // Add variations
  Object.entries(variations).forEach(([word, vars]) => {
    if (nameLower.includes(word)) {
      vars.forEach(v => {
        if (!nameLower.includes(v)) {
          aliases.push(v);
        }
      });
    }
  });

  return [...new Set(aliases)].join(' ');
}

// Helper function to generate tags based on product and category
function generateTags(name, category) {
  const tags = [];
  const nameLower = name.toLowerCase();
  const catLower = category.toLowerCase();

  // Size tags
  if (nameLower.match(/\bsmall\b/)) tags.push('small', 'compact', 'mini');
  if (nameLower.match(/\blarge\b/)) tags.push('large', 'big', 'jumbo');
  if (nameLower.match(/\bmedium\b/)) tags.push('medium', 'mid-size');
  if (nameLower.match(/\ba5\b/)) tags.push('a5', 'medium diary');
  if (nameLower.match(/\ba6\b/)) tags.push('a6', 'small diary', 'pocket diary');

  // Material tags
  if (nameLower.includes('cork')) tags.push('cork', 'eco-friendly', 'sustainable', 'natural');
  if (nameLower.includes('canvas')) tags.push('canvas', 'fabric');
  if (nameLower.includes('leather')) tags.push('leather', 'vegan leather');

  // Shape tags
  if (nameLower.match(/\bround\b/)) tags.push('round', 'circular');
  if (nameLower.match(/\bsquare\b/)) tags.push('square', 'rectangular');
  if (nameLower.match(/\bhexagon/)) tags.push('hexagon', 'hexagonal', '6-sided');
  if (nameLower.match(/\boval\b/)) tags.push('oval', 'elliptical');

  // Category-specific tags
  if (catLower.includes('coaster')) {
    tags.push('coaster', 'drink coaster', 'table protection', 'home decor');
  }
  if (catLower.includes('diar')) {
    tags.push('diary', 'notebook', 'journal', 'planner', 'writing', 'stationery');
  }
  if (catLower.includes('desk') || catLower.includes('organiz')) {
    tags.push('desk organizer', 'office', 'storage', 'stationery', 'workspace');
  }
  if (catLower.includes('planter')) {
    tags.push('planter', 'plants', 'flowers', 'home decor', 'garden');
  }
  if (catLower.includes('bag') || catLower.includes('laptop')) {
    tags.push('bag', 'carry', 'travel', 'laptop case', 'sleeve');
  }
  if (catLower.includes('wallet') || catLower.includes('purse')) {
    tags.push('wallet', 'money', 'cards', 'accessory');
  }
  if (catLower.includes('frame')) {
    tags.push('photo frame', 'picture', 'wall decor', 'display');
  }
  if (catLower.includes('tray')) {
    tags.push('tray', 'serving', 'table', 'dining', 'decor');
  }
  if (catLower.includes('yoga')) {
    tags.push('yoga', 'exercise', 'fitness', 'mat', 'workout');
  }
  if (catLower.includes('bottle')) {
    tags.push('bottle', 'water', 'drink', 'hydration');
  }
  if (catLower.includes('clock')) {
    tags.push('clock', 'time', 'wall clock', 'desk clock');
  }
  if (catLower.includes('tea light') || catLower.includes('candle')) {
    tags.push('tea light', 'candle', 'holder', 'home decor', 'lighting');
  }
  if (catLower.includes('travel')) {
    tags.push('travel', 'passport', 'organizer', 'cards', 'wallet');
  }

  // Use case tags
  if (nameLower.includes('pen')) tags.push('pen', 'pencil', 'writing', 'stationery');
  if (nameLower.includes('card')) tags.push('cards', 'business cards', 'credit cards');
  if (nameLower.includes('mobile') || nameLower.includes('phone')) tags.push('mobile', 'phone', 'smartphone');
  if (nameLower.includes('ipad') || nameLower.includes('tablet')) tags.push('ipad', 'tablet', 'device');
  if (nameLower.includes('test tube')) tags.push('test tube', 'unique', 'decorative');
  if (nameLower.includes('passport')) tags.push('passport', 'travel', 'documents');
  if (nameLower.includes('gift')) tags.push('gift', 'present', 'gifting', 'box');

  // Pattern tags
  if (nameLower.includes('print')) tags.push('printed', 'pattern', 'design');
  if (nameLower.includes('natural')) tags.push('natural', 'plain', 'simple');
  if (nameLower.includes('abstract')) tags.push('abstract', 'modern', 'art');
  if (nameLower.includes('linea')) tags.push('linea', 'lines', 'striped');

  return [...new Set(tags)].join(' ');
}

// Enrich each product
let enriched = 0;
data.forEach((product, index) => {
  // Skip if already has aliases and tags
  if (product.aliases && product.tags && product.aliases.trim() !== '' && product.tags.trim() !== '') {
    return;
  }

  const aliases = generateAliases(product.name, product.category);
  const tags = generateTags(product.name, product.category);

  product.aliases = aliases;
  product.tags = tags;
  enriched++;

  if (enriched % 50 === 0) {
    console.log(`✅ Enriched ${enriched} products...`);
  }
});

// Save enriched data
fs.writeFileSync(
  '/Users/kkaran/whatsapp-claude-bridge/scripts/products-data.json',
  JSON.stringify(data, null, 2)
);

console.log(`\n🎉 Enrichment complete!`);
console.log(`   Total products: ${data.length}`);
console.log(`   Newly enriched: ${enriched}`);
console.log(`   Already had data: ${data.length - enriched}`);

// Show samples
console.log('\n📝 Sample enriched products:');
data.slice(0, 5).forEach(p => {
  console.log(`\n${p.productId}: ${p.name}`);
  console.log(`   Aliases: ${p.aliases.substring(0, 60)}${p.aliases.length > 60 ? '...' : ''}`);
  console.log(`   Tags: ${p.tags.substring(0, 60)}${p.tags.length > 60 ? '...' : ''}`);
});
