// Check for duplicate image URLs in product database
const db = require('./product-image-database.json');

const imageMap = new Map();

for (const [catKey, category] of Object.entries(db.categories)) {
  for (const product of (category.products || [])) {
    for (const imgUrl of (product.images || [])) {
      if (!imageMap.has(imgUrl)) {
        imageMap.set(imgUrl, []);
      }
      imageMap.set(imgUrl, [...imageMap.get(imgUrl), product.name]);
    }
  }
}

console.log('='.repeat(70));
console.log('CHECKING FOR DUPLICATE IMAGE URLS');
console.log('='.repeat(70));

let duplicatesFound = 0;
for (const [imgUrl, products] of imageMap.entries()) {
  if (products.length > 1) {
    duplicatesFound++;
    console.log(`\n❌ DUPLICATE FOUND:`);
    console.log(`   Products: ${products.join(' & ')}`);
    console.log(`   URL: ${imgUrl}`);
  }
}

if (duplicatesFound === 0) {
  console.log('\n✅ No duplicate image URLs found!');
} else {
  console.log(`\n⚠️  Found ${duplicatesFound} duplicate image URL(s)`);
}

console.log('\n' + '='.repeat(70));
