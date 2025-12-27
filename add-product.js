#!/usr/bin/env node

// Interactive tool to add products to the database
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const DB_FILE = './product-image-database.json';

// Helper function to ask questions
function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// Helper to generate product ID
function generateProductId(category, products) {
  const categoryPrefix = category.substring(0, category.indexOf('_') > 0 ? category.indexOf('_') : 6);
  const nextNum = products.length + 1;
  return `${categoryPrefix}-${String(nextNum).padStart(3, '0')}`;
}

async function main() {
  console.log('='.repeat(80));
  console.log('ADD NEW PRODUCT TO DATABASE');
  console.log('='.repeat(80));

  // Load database
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

  // Show available categories
  console.log('\nAvailable Categories:');
  const categories = Object.keys(db.categories);
  categories.forEach((cat, idx) => {
    console.log(`  ${idx + 1}. ${cat} - ${db.categories[cat].displayName}`);
  });

  // Select category
  const catChoice = await question('\nSelect category number (or press Enter to create new): ');

  let categoryKey;
  let category;

  if (catChoice.trim() === '') {
    // Create new category
    console.log('\n--- Creating New Category ---');
    categoryKey = await question('Category key (e.g., "new_products"): ');
    const displayName = await question('Display name (e.g., "New Products"): ');
    const keywordsInput = await question('Keywords (comma-separated, e.g., "new, product, item"): ');

    db.categories[categoryKey] = {
      displayName: displayName,
      keywords: keywordsInput.split(',').map(k => k.trim()),
      products: []
    };
    category = db.categories[categoryKey];
    console.log(`✅ New category "${displayName}" created!`);
  } else {
    const idx = parseInt(catChoice) - 1;
    categoryKey = categories[idx];
    category = db.categories[categoryKey];
    console.log(`\nSelected: ${category.displayName}`);
  }

  // Get product details
  console.log('\n--- Product Details ---');
  const name = await question('Product name: ');
  const price = await question('Price (in ₹): ');

  // Get aliases
  console.log('\nAliases (alternate names customers might use):');
  console.log('Example: "card holder", "business card holder", "keychain"');
  const aliasesInput = await question('Aliases (comma-separated): ');
  const aliases = aliasesInput.split(',').map(a => a.trim()).filter(a => a.length > 0);

  // Get tags
  console.log('\nTags (keywords for this product):');
  console.log('Example: "card", "holder", "business"');
  const tagsInput = await question('Tags (comma-separated): ');
  const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t.length > 0);

  // Get images
  console.log('\nImage URLs:');
  console.log('Example: https://9cork.com/wp-content/uploads/2023/12/DSC09266-1024x683.jpg');
  const images = [];
  let addingImages = true;
  let imageNum = 1;

  while (addingImages) {
    const imageUrl = await question(`Image ${imageNum} URL (or press Enter to finish): `);
    if (imageUrl.trim() === '') {
      if (images.length === 0) {
        console.log('⚠️  At least one image is required!');
        continue;
      }
      addingImages = false;
    } else {
      images.push(imageUrl.trim());
      console.log(`  ✅ Image ${imageNum} added`);
      imageNum++;
    }
  }

  // Generate product ID
  const productId = generateProductId(categoryKey, category.products);

  // Create product object
  const newProduct = {
    id: productId,
    name: name,
    aliases: aliases,
    images: images,
    price: parseInt(price),
    tags: tags
  };

  // Show summary
  console.log('\n' + '='.repeat(80));
  console.log('PRODUCT SUMMARY');
  console.log('='.repeat(80));
  console.log(JSON.stringify(newProduct, null, 2));
  console.log('='.repeat(80));

  const confirm = await question('\nAdd this product to database? (yes/no): ');

  if (confirm.toLowerCase() === 'yes' || confirm.toLowerCase() === 'y') {
    // Add product to category
    category.products.push(newProduct);

    // Update metadata
    db.metadata.totalProducts++;
    db.metadata.lastUpdated = new Date().toISOString().split('T')[0];

    // Save database
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

    console.log('\n✅ Product added successfully!');
    console.log(`Total products in database: ${db.metadata.totalProducts}`);
    console.log('\n⚠️  NEXT STEPS:');
    console.log('1. Run: node extract-keywords.js');
    console.log('2. Update PRODUCT_KEYWORDS in server.js with the new keywords');
    console.log('3. Run: node check-duplicates.js (to verify no duplicate images)');
    console.log('4. Run: node test-image-database.js (to test the changes)');
  } else {
    console.log('\n❌ Product not added. Cancelled.');
  }

  rl.close();
}

main().catch(err => {
  console.error('Error:', err);
  rl.close();
  process.exit(1);
});
