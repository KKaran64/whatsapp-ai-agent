// Update prices for the 7 newly added products
const fs = require('fs');
const db = require('./product-image-database.json');

console.log('Updating prices for newly added products...\n');

// Price mappings
const priceUpdates = {
  'serve-004': 250,  // Cork Tablemats Aqua
  'desk-006': 250,   // Cork Rubberized Desktop Mat
  'desk-007': 390,   // Cork Stationery Organizer
  'desk-008': 330,   // Cork Organizer Trinket Tray
  'desk-009': 360,   // Cork Pen Pencil Holder
  'planter-007': 350, // Cork U-Shaped Test Tube Planter
  'diary-004': 399   // Cork Minimalistic Desk Calendar
};

let updatedCount = 0;

// Update prices in each category
for (const categoryKey in db.categories) {
  const category = db.categories[categoryKey];
  for (const product of category.products) {
    if (priceUpdates[product.id] !== undefined) {
      const oldPrice = product.price;
      product.price = priceUpdates[product.id];
      console.log(`✅ Updated ${product.name}: ₹${oldPrice} → ₹${product.price}`);
      updatedCount++;
    }
  }
}

// Save updated database
fs.writeFileSync('./product-image-database.json', JSON.stringify(db, null, 2));

console.log(`\n✅ Successfully updated prices for ${updatedCount} products!`);
