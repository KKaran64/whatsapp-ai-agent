// Convert Excel to JSON
const XLSX = require('xlsx');
const fs = require('fs');

// Read Excel
const workbook = XLSX.readFile('/Users/kkaran/whatsapp-claude-bridge/PRODUCT DATABASE UPDATED NEW.xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log('📦 Converting Excel to JSON...');
console.log('   Total products:', data.length);

// Transform to products-data.json format
const products = data.map(row => {
  const images = [
    row['IMAGE LINK 1'],
    row['IMAGE LINK 2'],
    row['IMAGE LINK 3']
  ].filter(url => url && url.trim() && url !== '\\');

  return {
    productId: row['Product ID'],
    name: row['PRODUCT NAME'],
    category: row['Category'],
    price: parseFloat(row['PRICE FOR 100- 500 pcs']) || 0,
    images: images,
    aliases: row['Aliases'] || '',
    tags: row['Tags'] || '',
    source: row['Source'] || ''
  };
});

console.log('✅ Converted', products.length, 'products');

// Now update calendars with correct Google Drive URLs and price
console.log('\n📝 Updating calendar products...');

products.forEach(p => {
  if (p.productId === '9C-DA23') {
    console.log('   Updating 9C-DA23: SMALL CALENDER');
    p.price = 225; // Correct price
    p.images = [
      'https://drive.google.com/file/d/1D1cXBzdG2VCNOd0zeTBbmplMHyCkrJfK/view?usp=sharing',
      'https://drive.google.com/file/d/12xPXl_qyr2z-5ShqYaCcXc4wMnQ04nrC/view?usp=sharing'
    ];
    p.aliases = 'small calendar desk calendar';
    p.tags = 'calendar calender desk table';
  }

  if (p.productId === '9C-DA24') {
    console.log('   Updating 9C-DA24: LARGE TABLE CALENDER');
    p.price = 225; // Correct price
    p.images = [
      'https://drive.google.com/file/d/1HRpdQ5935vJKa4755VMRzskSLkkK0Ykf/view?usp=drive_link',
      'https://drive.google.com/file/d/1YYy8zTDzFhv6TvcY0A9UmxT-pbIVvNYW/view?usp=drive_link'
    ];
    p.aliases = 'large calendar table calendar desk calendar';
    p.tags = 'calendar calender desk table';
  }
});

// Save to JSON
fs.writeFileSync(
  '/Users/kkaran/whatsapp-claude-bridge/scripts/products-data.json',
  JSON.stringify(products, null, 2)
);

console.log('\n✅ Saved to scripts/products-data.json');
console.log('   Total products:', products.length);

// Summary
const withDrive = products.filter(p => p.images.some(img => img.includes('drive.google.com')));
const withOld = products.filter(p => p.images.some(img => img.includes('homedecorzstore')));

console.log('\n📊 Summary:');
console.log('   Products with Google Drive URLs:', withDrive.length);
console.log('   Products with homedecorzstore URLs:', withOld.length);
