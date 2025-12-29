// Seed Products from JSON to MongoDB
// Usage: node scripts/seed-products.js

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const productsData = require('./products-data.json');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-sales';

async function seedProducts() {
  try {
    console.log('📦 Starting product seeding...');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Connected to MongoDB');

    // Clear existing products
    console.log('🗑️  Clearing existing products...');
    const deleteResult = await Product.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} existing products`);

    // Insert products
    console.log(`📝 Inserting ${productsData.length} products...`);
    await Product.insertMany(productsData, { ordered: false });

    console.log('✅ Product seeding completed successfully!');

    // Verify
    const count = await Product.countDocuments();
    console.log(`\n✅ Verification: ${count} products in database`);

    // Show summary
    const categories = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    console.log('\n📋 Products by category:');
    categories.forEach(cat => {
      console.log(`   ${cat._id}: ${cat.count} products`);
    });

  } catch (error) {
    console.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Run seeding
seedProducts()
  .then(() => {
    console.log('\n✅ Seeding script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Seeding script failed:', error);
    process.exit(1);
  });
