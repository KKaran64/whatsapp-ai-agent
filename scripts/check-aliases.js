const data = require('./products-data.json');

const withAliases = data.filter(p => p.aliases && p.aliases.trim() !== '');
const withTags = data.filter(p => p.tags && p.tags.trim() !== '');

console.log('📊 Current Status:');
console.log('   Total products: ' + data.length);
console.log('   Products with aliases: ' + withAliases.length);
console.log('   Products with tags: ' + withTags.length);
console.log('   Products needing enrichment: ' + (data.length - Math.max(withAliases.length, withTags.length)));

console.log('\n📋 Products by category:');
const categories = {};
data.forEach(p => {
  categories[p.category] = (categories[p.category] || 0) + 1;
});

Object.entries(categories).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
  console.log('   ' + cat + ': ' + count);
});
