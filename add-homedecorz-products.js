// Add homedecorzstore.com cork products to database
const fs = require('fs');
const db = require('./product-image-database.json');

console.log('Adding 7 new cork products from homedecorzstore.com...\n');

// 1. Add new photo_frames category
db.categories.photo_frames = {
  "displayName": "Cork Photo Frames",
  "keywords": ["photo", "frame", "picture", "frames"],
  "products": [
    {
      "id": "photo-001",
      "name": "Cork Photo Frame Natural",
      "aliases": ["photo frame", "picture frame", "cork frame", "natural frame"],
      "images": ["https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg"],
      "price": 749,
      "tags": ["photo", "frame", "natural"]
    }
  ]
};

// 2. Add coasters from homedecorzstore
db.categories.coasters.products.push(
  {
    "id": "coaster-006",
    "name": "Premium Square Cork Coaster with Case",
    "aliases": ["square coaster with case", "premium coasters", "coaster set with case"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2025/08/DSC06464.jpg"],
    "price": 399,
    "tags": ["square", "premium", "case", "set"]
  },
  {
    "id": "coaster-007",
    "name": "Cork Coasters Natural",
    "aliases": ["natural coasters", "round coasters", "cork coaster set"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2021/06/IMG_0839.jpg"],
    "price": 399,
    "tags": ["natural", "round", "set"]
  }
);

// 3. Add wallet from homedecorzstore
db.categories.bags_wallets.products.push({
  "id": "wallet-005",
  "name": "Cork Wallet Box Print",
  "aliases": ["box print wallet", "patterned wallet", "designer wallet"],
  "images": ["https://homedecorzstore.com/wp-content/uploads/2024/03/DSC05918.jpg"],
  "price": 699,
  "tags": ["wallet", "box", "print", "pattern"]
});

// 4. Add calendar to diaries category
db.categories.diaries.products.push({
  "id": "diary-003",
  "name": "Cork Table Calendar with Case",
  "aliases": ["table calendar", "desk calendar with case", "calendar with pen holder"],
  "images": ["https://homedecorzstore.com/wp-content/uploads/2024/03/DSC08640.jpg"],
  "price": 399,
  "tags": ["calendar", "table", "case", "desk"]
});

// 5. Add planter from homedecorzstore
db.categories.planters.products.push({
  "id": "planter-006",
  "name": "Cork Aqua Flat Planter",
  "aliases": ["flat planter", "aqua planter", "table planter"],
  "images": ["https://homedecorzstore.com/wp-content/uploads/2021/10/IMG_0154.jpg"],
  "price": 450,
  "tags": ["flat", "aqua", "table"]
});

// 6. Add trivet to serving_decor
db.categories.serving_decor.products.push({
  "id": "serve-003",
  "name": "Cork Trivets Natural",
  "aliases": ["trivet", "trivets", "hot pad", "pot holder"],
  "images": ["https://homedecorzstore.com/wp-content/uploads/2022/01/IMG_0588.jpg"],
  "price": 350,
  "tags": ["trivet", "natural", "hot", "pad"]
});

// Update metadata
db.metadata.totalProducts = 34;  // Was 27, now 34 (added 7)
db.metadata.totalCategories = 8; // Was 7, now 8 (added photo_frames)
db.metadata.lastUpdated = "2025-12-25";
db.metadata.version = "1.2";

// Save updated database
fs.writeFileSync('./product-image-database.json', JSON.stringify(db, null, 2));

console.log('✅ Successfully added 7 new cork products!');
console.log('\nDatabase Summary:');
console.log(`  Total Products: ${db.metadata.totalProducts}`);
console.log(`  Total Categories: ${db.metadata.totalCategories}`);
console.log(`  Version: ${db.metadata.version}`);
console.log('\nNew products added:');
console.log('  1. Cork Photo Frame Natural (₹749)');
console.log('  2. Premium Square Cork Coaster with Case (₹399)');
console.log('  3. Cork Coasters Natural (₹399)');
console.log('  4. Cork Wallet Box Print (₹699)');
console.log('  5. Cork Table Calendar with Case (₹399)');
console.log('  6. Cork Aqua Flat Planter (₹450)');
console.log('  7. Cork Trivets Natural (₹350)');
console.log('\nNext steps:');
console.log('  1. Run: node extract-keywords.js');
console.log('  2. Update PRODUCT_KEYWORDS in server.js');
console.log('  3. Run: node check-duplicates.js');
console.log('  4. Run: node list-products.js');
