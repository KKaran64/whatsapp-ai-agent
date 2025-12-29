// Import Products from Excel to MongoDB
// Usage: node scripts/import-products.js

require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const path = require('path');
const Product = require('../models/Product');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-sales';

async function importProducts() {
  try {
    console.log('📦 Starting product import...');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Connected to MongoDB');

    // Read Excel file
    const excelPath = '/Users/kkaran/Downloads/PRODUCT _DATABASE_UPDATED.xlsx';
    console.log(`📖 Reading Excel file: ${excelPath}`);

    const workbook = XLSX.readFile(excelPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log(`✅ Found ${data.length} products in Excel file`);

    // Clear existing products
    console.log('🗑️  Clearing existing products...');
    const deleteResult = await Product.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} existing products`);

    // Transform and insert products
    console.log('📝 Transforming and inserting products...');

    const products = data.map(row => {
      // Collect all image URLs
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
        source: row['Source'] || '',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date()
        }
      };
    });

    // Insert in batches of 50
    const batchSize = 50;
    let imported = 0;

    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      await Product.insertMany(batch, { ordered: false });
      imported += batch.length;
      console.log(`✅ Imported ${imported}/${products.length} products`);
    }

    console.log('✅ Product import completed successfully!');
    console.log(`\n📊 Summary:`);
    console.log(`   Total products: ${imported}`);
    console.log(`   Categories: ${[...new Set(products.map(p => p.category))].length}`);

    // Verify
    const count = await Product.countDocuments();
    console.log(`\n✅ Verification: ${count} products in database`);

    // Show sample products by category
    const categories = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    console.log('\n📋 Products by category:');
    categories.forEach(cat => {
      console.log(`   ${cat._id}: ${cat.count} products`);
    });

  } catch (error) {
    console.error('❌ Import failed:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Run import
importProducts()
  .then(() => {
    console.log('\n✅ Import script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Import script failed:', error);
    process.exit(1);
  });
