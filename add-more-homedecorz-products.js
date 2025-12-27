// Add 7 more cork products from homedecorzstore.com to database
const fs = require('fs');
const db = require('./product-image-database.json');

console.log('Adding 7 more cork products from homedecorzstore.com...\n');

// 1. Add table mats to serving_decor category
db.categories.serving_decor.keywords.push('tablemat', 'tablemats', 'placemat', 'placemats');
db.categories.serving_decor.products.push(
  {
    "id": "serve-004",
    "name": "Cork Tablemats Aqua",
    "aliases": ["aqua tablemat", "aqua placemat", "table mat aqua", "dining mat"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2021/06/IMG_5748.jpg"],
    "price": 0,
    "tags": ["tablemat", "aqua", "dining", "mat"]
  }
);

// 2. Add desktop mat to desk_organizers
db.categories.desk_organizers.products.push(
  {
    "id": "desk-006",
    "name": "Cork Rubberized Desktop Mat",
    "aliases": ["desktop mat", "desk mat rubberized", "mouse mat", "workspace mat"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2024/03/DSC04828.jpg"],
    "price": 0,
    "tags": ["desktop", "mat", "rubberized", "workspace"]
  }
);

// 3. Add stationery organizer to desk_organizers
db.categories.desk_organizers.products.push(
  {
    "id": "desk-007",
    "name": "Cork Stationery Organizer",
    "aliases": ["stationery holder", "pen organizer", "desk organizer", "office organizer"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2024/03/DSC08897-scaled.jpg"],
    "price": 0,
    "tags": ["stationery", "organizer", "pen", "office"]
  }
);

// 4. Add trinket tray to desk_organizers
db.categories.desk_organizers.products.push(
  {
    "id": "desk-008",
    "name": "Cork Organizer Trinket Tray",
    "aliases": ["trinket tray", "desk tray", "organizer tray", "catchall tray"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2024/04/DSC08981.jpg"],
    "price": 0,
    "tags": ["trinket", "tray", "organizer", "desk"]
  }
);

// 5. Add pen holder to desk_organizers
db.categories.desk_organizers.products.push(
  {
    "id": "desk-009",
    "name": "Cork Pen Pencil Holder",
    "aliases": ["pen holder", "pencil holder", "pen stand", "desk accessory"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2024/03/DSC05835.jpg"],
    "price": 0,
    "tags": ["pen", "pencil", "holder", "stand"]
  }
);

// 6. Add U-shaped planter to planters
db.categories.planters.products.push(
  {
    "id": "planter-007",
    "name": "Cork U-Shaped Test Tube Planter",
    "aliases": ["u shaped planter", "test tube planter", "hanging planter", "wall planter"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2024/03/DSC09368.jpg"],
    "price": 0,
    "tags": ["planter", "test", "tube", "hanging", "wall"]
  }
);

// 7. Add minimalistic calendar to diaries
db.categories.diaries.products.push(
  {
    "id": "diary-004",
    "name": "Cork Minimalistic Desk Calendar",
    "aliases": ["desk calendar", "minimalistic calendar", "table calendar", "calendar stand"],
    "images": ["https://homedecorzstore.com/wp-content/uploads/2024/03/DSC05846.jpg"],
    "price": 0,
    "tags": ["calendar", "desk", "minimalistic", "table"]
  }
);

// Update metadata
db.metadata.totalProducts = 41;  // Was 34, now 41 (added 7)
db.metadata.lastUpdated = "2025-12-25";
db.metadata.version = "1.3";

// Save updated database
fs.writeFileSync('./product-image-database.json', JSON.stringify(db, null, 2));

console.log('✅ Successfully added 7 more cork products!');
console.log('\nDatabase Summary:');
console.log(`  Total Products: ${db.metadata.totalProducts}`);
console.log(`  Total Categories: ${db.metadata.totalCategories}`);
console.log(`  Version: ${db.metadata.version}`);
console.log('\nNew products added (prices = ₹0, update later):');
console.log('  1. Cork Tablemats Aqua (₹0)');
console.log('  2. Cork Rubberized Desktop Mat (₹0)');
console.log('  3. Cork Stationery Organizer (₹0)');
console.log('  4. Cork Organizer Trinket Tray (₹0)');
console.log('  5. Cork Pen Pencil Holder (₹0)');
console.log('  6. Cork U-Shaped Test Tube Planter (₹0)');
console.log('  7. Cork Minimalistic Desk Calendar (₹0)');
console.log('\nNOTE: Prices are set to ₹0 - update them in product-image-database.json');
console.log('\nNext steps:');
console.log('  1. Update prices in product-image-database.json');
console.log('  2. Run: node extract-keywords.js');
console.log('  3. Update PRODUCT_KEYWORDS in server.js');
console.log('  4. Run: node check-duplicates.js');
console.log('  5. Run: node test-image-database.js');
