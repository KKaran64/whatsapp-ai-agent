// Import products from Excel back to product-image-database.json
const XLSX = require('xlsx');
const fs = require('fs');

console.log('Importing products from Excel...\n');

// Read the Excel file
const workbook = XLSX.readFile('cork-products-database.xlsx');
const worksheet = workbook.Sheets['Cork Products'];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log(`Found ${data.length} products in Excel file\n`);

// Load existing database
const db = require('./product-image-database.json');

// Category mapping (display name to key)
const categoryMap = {
  'Cork Coasters': 'coasters',
  'Cork Bags & Wallets': 'bags_wallets',
  'Cork Diaries': 'diaries',
  'Cork Desk Organizers': 'desk_organizers',
  'Cork Planters': 'planters',
  'Cork Fridge Magnets': 'fridge_magnets',
  'Cork Serving & Decor': 'serving_decor',
  'Cork Photo Frames': 'photo_frames'
};

// Track new products
let newProducts = [];
let updatedProducts = [];

// Process each row from Excel
data.forEach(row => {
  const categoryKey = categoryMap[row.Category];
  
  if (!categoryKey) {
    console.log(`⚠️  Unknown category: ${row.Category} for product ${row['Product Name']}`);
    return;
  }
  
  // Ensure category exists
  if (!db.categories[categoryKey]) {
    console.log(`⚠️  Category ${categoryKey} not found in database`);
    return;
  }
  
  // Find existing product
  const existingIndex = db.categories[categoryKey].products.findIndex(
    p => p.id === row['Product ID']
  );
  
  // Prepare product object
  const images = [];
  if (row['Image URL 1']) images.push(row['Image URL 1']);
  if (row['Image URL 2']) images.push(row['Image URL 2']);
  if (row['Image URL 3']) images.push(row['Image URL 3']);
  
  const product = {
    id: row['Product ID'],
    name: row['Product Name'],
    aliases: row.Aliases ? row.Aliases.split(',').map(a => a.trim()) : [],
    images: images,
    price: row['Price (INR)'] || 0,
    tags: row.Tags ? row.Tags.split(',').map(t => t.trim()) : []
  };
  
  if (existingIndex >= 0) {
    // Update existing product
    db.categories[categoryKey].products[existingIndex] = product;
    updatedProducts.push(product.name);
  } else {
    // Add new product
    db.categories[categoryKey].products.push(product);
    newProducts.push(product.name);
  }
});

// Update metadata
let totalProducts = 0;
for (const categoryKey in db.categories) {
  totalProducts += db.categories[categoryKey].products.length;
}

db.metadata.totalProducts = totalProducts;
db.metadata.lastUpdated = new Date().toISOString().split('T')[0];
const currentVersion = parseFloat(db.metadata.version);
db.metadata.version = (currentVersion + 0.1).toFixed(1);

// Save updated database
fs.writeFileSync('./product-image-database.json', JSON.stringify(db, null, 2));

console.log('✅ Import complete!\n');
console.log(`New products added: ${newProducts.length}`);
if (newProducts.length > 0) {
  newProducts.forEach(name => console.log(`  + ${name}`));
}

console.log(`\nProducts updated: ${updatedProducts.length}`);
if (updatedProducts.length > 0 && updatedProducts.length <= 10) {
  updatedProducts.forEach(name => console.log(`  ✓ ${name}`));
}

console.log(`\nTotal products in database: ${totalProducts}`);
console.log(`Database version: ${db.metadata.version}`);

console.log('\n📋 Next steps:');
console.log('  1. Run: node extract-keywords.js');
console.log('  2. Update PRODUCT_KEYWORDS in server.js');
console.log('  3. Run: node check-duplicates.js');
console.log('  4. Run: node test-image-database.js');
