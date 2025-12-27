// List all products in the database with details
const db = require('./product-image-database.json');

console.log('='.repeat(80));
console.log('PRODUCT DATABASE SUMMARY');
console.log('='.repeat(80));

console.log(`\nDatabase Version: ${db.metadata.version}`);
console.log(`Last Updated: ${db.metadata.lastUpdated}`);
console.log(`Total Products: ${db.metadata.totalProducts}`);
console.log(`Total Categories: ${db.metadata.totalCategories}`);

console.log('\n' + '='.repeat(80));
console.log('PRODUCTS BY CATEGORY');
console.log('='.repeat(80));

let productCount = 0;

for (const [catKey, category] of Object.entries(db.categories)) {
  console.log(`\n📂 ${category.displayName.toUpperCase()}`);
  console.log(`   Keywords: ${category.keywords.join(', ')}`);
  console.log(`   Products (${category.products.length}):`);
  console.log('   ' + '-'.repeat(76));

  category.products.forEach((product, idx) => {
    productCount++;
    console.log(`\n   ${productCount}. ${product.name} (ID: ${product.id})`);
    console.log(`      Price: ₹${product.price}`);
    console.log(`      Aliases: ${product.aliases.join(', ')}`);
    console.log(`      Tags: ${product.tags.join(', ')}`);
    console.log(`      Images (${product.images.length}):`);
    product.images.forEach((img, imgIdx) => {
      const imgName = img.split('/').pop();
      console.log(`         ${imgIdx + 1}. ${imgName}`);
    });
  });
}

console.log('\n' + '='.repeat(80));
console.log(`TOTAL: ${productCount} products listed`);
console.log('='.repeat(80));
