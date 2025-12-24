// Test script for new product image database system
const { findProductImage, getCatalogImages, getDatabaseStats } = require('./product-images-v2');

console.log('='.repeat(70));
console.log('TESTING PRODUCT IMAGE DATABASE V2');
console.log('='.repeat(70));

// Get database stats
console.log('\n📊 DATABASE STATS:');
const stats = getDatabaseStats();
console.log(JSON.stringify(stats, null, 2));

console.log('\n' + '='.repeat(70));
console.log('TESTING INDIVIDUAL PRODUCT SEARCHES');
console.log('='.repeat(70));

// Test cases from the WhatsApp conversation
const testQueries = [
  'water bottle',
  'borosil water bottle',
  'card holder',
  'desk mat',
  'desktop mat',
  'planters',
  'planter',
  'test tube planter',
  'cork coasters',
  'diary',
  'a5 diary',
  'laptop bag',
  'wallet'
];

console.log('\n🔍 Testing product searches:');
testQueries.forEach(query => {
  console.log(`\n📌 Query: "${query}"`);
  const result = findProductImage(query);
  if (result) {
    console.log(`   ✅ FOUND: ${result.substring(0, 80)}...`);
  } else {
    console.log(`   ❌ NOT FOUND`);
  }
});

console.log('\n' + '='.repeat(70));
console.log('TESTING CATEGORY SEARCHES');
console.log('='.repeat(70));

const categoryTests = [
  'coasters',
  'planters',
  'desk organizers',
  'diaries',
  'wallets'
];

console.log('\n📁 Testing category searches:');
categoryTests.forEach(category => {
  console.log(`\n📂 Category: "${category}"`);
  const images = getCatalogImages(category);
  console.log(`   Found ${images.length} images`);
  images.forEach((img, idx) => {
    console.log(`   ${idx + 1}. ${img.substring(0, 70)}...`);
  });
});

console.log('\n' + '='.repeat(70));
console.log('TEST COMPLETE');
console.log('='.repeat(70));
