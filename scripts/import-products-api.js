// API Endpoint to Import Products from Excel
// Add this to server.js to trigger import via HTTP request

const XLSX = require('xlsx');
const Product = require('./models/Product');

async function importProductsFromExcel(excelPath) {
  try {
    console.log('📦 Starting product import from API...');

    // Read Excel file
    console.log(`📖 Reading Excel from: ${excelPath}`);

    const workbook = XLSX.readFile(excelPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log(`✅ Found ${data.length} products in Excel file`);

    // Clear existing products
    console.log('🗑️  Clearing existing products...');
    const deleteResult = await Product.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} existing products`);

    // Transform products
    const products = data.map(row => {
      const images = [
        row['Image URL 1'],
        row['Image URL 2'],
        row['Image URL 3']
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

    // Insert products
    await Product.insertMany(products, { ordered: false });

    console.log(`✅ Imported ${products.length} products`);

    const categories = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    return {
      success: true,
      imported: products.length,
      categories: categories.map(c => ({ category: c._id, count: c.count }))
    };

  } catch (error) {
    console.error('❌ Import failed:', error);
    throw error;
  }
}

module.exports = { importProductsFromExcel };
