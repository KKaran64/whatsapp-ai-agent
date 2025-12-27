// Export product-image-database.json to Excel format
const XLSX = require('xlsx');
const fs = require('fs');
const db = require('./product-image-database.json');

console.log('Exporting product database to Excel...\n');

// Prepare data rows for the Excel file
const rows = [];

// Add header row
rows.push([
  'Product ID',
  'Product Name',
  'Category',
  'Price (INR)',
  'Image URL 1',
  'Image URL 2',
  'Image URL 3',
  'Aliases',
  'Tags',
  'Source'
]);

// Process each category
for (const categoryKey in db.categories) {
  const category = db.categories[categoryKey];
  const displayName = category.displayName;
  
  for (const product of category.products) {
    rows.push([
      product.id,
      product.name,
      displayName,
      product.price,
      product.images[0] || '',
      product.images[1] || '',
      product.images[2] || '',
      product.aliases ? product.aliases.join(', ') : '',
      product.tags ? product.tags.join(', ') : '',
      product.id.includes('coaster-006') || product.id.includes('coaster-007') || 
      product.id.includes('photo-001') || product.id.includes('wallet-005') ||
      product.id.includes('diary-003') || product.id.includes('planter-006') ||
      product.id.includes('serve-003') || product.id.includes('serve-004') ||
      product.id.includes('desk-006') || product.id.includes('desk-007') ||
      product.id.includes('desk-008') || product.id.includes('desk-009') ||
      product.id.includes('planter-007') || product.id.includes('diary-004')
        ? 'homedecorzstore.com' : '9cork.com'
    ]);
  }
}

// Create workbook and worksheet
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet(rows);

// Set column widths
ws['!cols'] = [
  { wch: 12 },  // Product ID
  { wch: 40 },  // Product Name
  { wch: 20 },  // Category
  { wch: 12 },  // Price
  { wch: 60 },  // Image URL 1
  { wch: 60 },  // Image URL 2
  { wch: 60 },  // Image URL 3
  { wch: 50 },  // Aliases
  { wch: 30 },  // Tags
  { wch: 20 }   // Source
];

// Add worksheet to workbook
XLSX.utils.book_append_sheet(wb, ws, 'Cork Products');

// Write to file
XLSX.writeFile(wb, 'cork-products-database.xlsx');

console.log('✅ Successfully created cork-products-database.xlsx!');
console.log('\nFile details:');
console.log(`  Total Products: ${db.metadata.totalProducts}`);
console.log(`  Total Categories: ${db.metadata.totalCategories}`);
console.log(`  Database Version: ${db.metadata.version}`);
console.log(`  Last Updated: ${db.metadata.lastUpdated}`);
console.log('\nColumns in Excel file:');
console.log('  1. Product ID');
console.log('  2. Product Name');
console.log('  3. Category');
console.log('  4. Price (INR)');
console.log('  5. Image URL 1');
console.log('  6. Image URL 2');
console.log('  7. Image URL 3');
console.log('  8. Aliases');
console.log('  9. Tags');
console.log('  10. Source');
console.log('\nYou can now:');
console.log('  - Open cork-products-database.xlsx in Excel/Numbers/Google Sheets');
console.log('  - Edit products directly in Excel');
console.log('  - Add new Pinterest products to the spreadsheet');
console.log('  - Use import-from-excel.js to import changes back to JSON');
