// Run Comprehensive Product Tests
// Tests all product queries against the JSON database

const productsData = require('../scripts/products-data.json');

// Test cases covering all 19 categories
const testCases = [
  // === COASTERS (19 products) ===
  { query: 'coasters', category: 'COASTER', expectedMin: 1, description: 'Basic coaster search' },
  { query: 'costers', category: 'COASTER', expectedMin: 1, description: 'Coaster misspelling' },
  { query: 'round coasters', category: 'COASTER', expectedMin: 1, description: 'Round coasters' },
  { query: 'square coasters', category: 'COASTER', expectedMin: 1, description: 'Square coasters' },
  { query: 'coaster set', category: 'COASTER', expectedMin: 1, description: 'Coaster sets' },
  { query: 'drink coasters', category: 'COASTER', expectedMin: 1, description: 'Drink coasters via tags' },
  { query: 'hexagon coaster', category: 'COASTER', expectedMin: 1, description: 'Hexagon shape' },

  // === DIARIES (7 products) ===
  { query: 'diaries', category: 'DIAR', expectedMin: 1, description: 'Basic diary search' },
  { query: 'notebook', category: 'DIAR', expectedMin: 1, description: 'Notebook via tags' },
  { query: 'journal', category: 'DIAR', expectedMin: 1, description: 'Journal via tags' },
  { query: 'planner', category: 'DIAR', expectedMin: 1, description: 'Planner via tags' },
  { query: 'a5 diary', category: 'DIAR', expectedMin: 1, description: 'A5 size diary' },
  { query: 'a6 diary', category: 'DIAR', expectedMin: 1, description: 'A6 size diary' },
  { query: 'diry', category: 'DIAR', expectedMin: 1, description: 'Diary misspelling' },

  // === CALENDARS (3 products) ===
  { query: 'calendars', category: 'DESKTOP', expectedMin: 1, description: 'Calendar search' },
  { query: 'calenders', category: 'DESKTOP', expectedMin: 1, description: 'Calendar misspelling' },
  { query: 'desk calendar', category: 'DESKTOP', expectedMin: 1, description: 'Desk calendar' },
  { query: 'table calendar', category: 'DESKTOP', expectedMin: 1, description: 'Table calendar' },
  { query: 'small calendar', category: 'DESKTOP', expectedMin: 1, description: 'Small calendar' },
  { query: 'large calendar', category: 'DESKTOP', expectedMin: 1, description: 'Large calendar' },

  // === DESK ORGANIZERS (27 products) ===
  { query: 'desk organizer', category: 'DESKTOP', expectedMin: 1, description: 'Desk organizer' },
  { query: 'organiser', category: 'DESKTOP', expectedMin: 1, description: 'British spelling' },
  { query: 'pen holder', category: 'DESKTOP', expectedMin: 1, description: 'Pen holder' },
  { query: 'pencil holder', category: 'DESKTOP', expectedMin: 1, description: 'Pencil holder via tags' },
  { query: 'office organizer', category: 'DESKTOP', expectedMin: 1, description: 'Office organizer via tags' },
  { query: 'mobile holder', category: 'DESKTOP', expectedMin: 1, description: 'Mobile holder' },

  // === PLANTERS (42 products) ===
  { query: 'planters', category: 'PLANTER', expectedMin: 1, description: 'Planter search' },
  { query: 'test tube planter', category: 'TEST TUBE', expectedMin: 1, description: 'Test tube planter' },
  { query: 'table top planter', category: 'TABLE TOP', expectedMin: 1, description: 'Table top planter' },
  { query: 'fridge magnet planter', category: 'PLANTER', expectedMin: 1, description: 'Fridge magnet planter' },
  { query: 'pot', category: 'PLANTER', expectedMin: 1, description: 'Pot as alias' },

  // === BAGS & WALLETS (24 products) ===
  { query: 'laptop bag', category: 'LAPTOP', expectedMin: 1, description: 'Laptop bag' },
  { query: 'laptop sleeve', category: 'LAPTOP', expectedMin: 1, description: 'Laptop sleeve' },
  { query: 'lap top', category: 'LAPTOP', expectedMin: 1, description: 'Laptop misspelling' },
  { query: 'wallet', category: 'BAG', expectedMin: 1, description: 'Wallet search' },
  { query: 'purse', category: 'BAG', expectedMin: 1, description: 'Purse as alias' },
  { query: 'clutch', category: 'BAG', expectedMin: 1, description: 'Clutch bag' },
  { query: 'sling bag', category: 'BAG', expectedMin: 1, description: 'Sling bag' },

  // === TRAVEL ORGANIZERS (13 products) ===
  { query: 'passport holder', category: 'TRAVEL', expectedMin: 1, description: 'Passport holder' },
  { query: 'travel organizer', category: 'TRAVEL', expectedMin: 1, description: 'Travel organizer' },
  { query: 'travel wallet', category: 'TRAVEL', expectedMin: 1, description: 'Travel wallet' },

  // === PHOTO FRAMES (8 products) ===
  { query: 'photo frame', category: 'FRAME', expectedMin: 1, description: 'Photo frame' },
  { query: 'picture frame', category: 'FRAME', expectedMin: 1, description: 'Picture frame alias' },
  { query: 'photoframe', category: 'FRAME', expectedMin: 1, description: 'Photoframe single word' },

  // === TRAYS (12 products) ===
  { query: 'serving tray', category: 'TRAY', expectedMin: 1, description: 'Serving tray' },
  { query: 'tray', category: 'TRAY', expectedMin: 1, description: 'Basic tray' },

  // === TEA LIGHT HOLDERS (12 products) ===
  { query: 'tea light', category: 'TEA LIGHT', expectedMin: 1, description: 'Tea light holder' },
  { query: 'candle holder', category: 'TEA LIGHT', expectedMin: 1, description: 'Candle holder' },
  { query: 'tealight', category: 'TEA LIGHT', expectedMin: 1, description: 'Tealight single word' },

  // === BOTTLES (4 products) ===
  { query: 'bottle', category: 'BOTTLE', expectedMin: 1, description: 'Bottle search' },
  { query: 'water bottle', category: 'BOTTLE', expectedMin: 1, description: 'Water bottle' },

  // === YOGA MATS (7 products) ===
  { query: 'yoga mat', category: 'YOGA', expectedMin: 1, description: 'Yoga mat' },
  { query: 'exercise mat', category: 'YOGA', expectedMin: 1, description: 'Exercise mat via tags' },

  // === TABLE MATS (4 products) ===
  { query: 'table mat', category: 'TABLEMAT', expectedMin: 1, description: 'Table mat' },
  { query: 'placemat', category: 'TABLEMAT', expectedMin: 1, description: 'Placemat' },

  // === TRIVETS (5 products) ===
  { query: 'trivet', category: 'TRIVET', expectedMin: 1, description: 'Trivet' },
  { query: 'hot plate', category: 'TRIVET', expectedMin: 1, description: 'Hot plate' },

  // === CLOCKS (3 products) ===
  { query: 'clock', category: 'CLOCK', expectedMin: 1, description: 'Clock search' },
  { query: 'table clock', category: 'CLOCK', expectedMin: 1, description: 'Table clock' },

  // === GIFT BOXES (6 products) ===
  { query: 'gift box', category: 'GIFT', expectedMin: 1, description: 'Gift box' },

  // === GAMES (2 products) ===
  { query: 'game', category: 'GAME', expectedMin: 1, description: 'Game search' },

  // === SHELF DECOR (1 product) ===
  { query: 'shelf decor', category: 'SHELF', expectedMin: 1, description: 'Shelf decor' },
];

function searchProducts(query, category) {
  const queryLower = query.toLowerCase();

  return productsData.filter(product => {
    const nameLower = product.name.toLowerCase();
    const categoryLower = product.category.toLowerCase();
    const aliasesLower = (product.aliases || '').toLowerCase();
    const tagsLower = (product.tags || '').toLowerCase();

    // Check if query matches
    const matchesName = nameLower.includes(queryLower);
    const matchesAliases = aliasesLower.includes(queryLower);
    const matchesTags = tagsLower.includes(queryLower);
    const matchesCategory = category ? categoryLower.includes(category.toLowerCase()) : true;

    return (matchesName || matchesAliases || matchesTags) && matchesCategory;
  });
}

function runTests() {
  console.log('\n🧪 COMPREHENSIVE PRODUCT ENRICHMENT TESTS');
  console.log('='.repeat(60));
  console.log(`Total test cases: ${testCases.length}`);
  console.log(`Total products: ${productsData.length}\n`);

  const results = {
    passed: 0,
    failed: 0,
    failures: []
  };

  testCases.forEach((test, index) => {
    const products = searchProducts(test.query, test.category);
    const passed = products.length >= test.expectedMin;

    if (passed) {
      results.passed++;
      console.log(`✅ [${index + 1}/${testCases.length}] "${test.query}" → ${products.length} products (${test.description})`);
    } else {
      results.failed++;
      console.log(`❌ [${index + 1}/${testCases.length}] "${test.query}" → ${products.length} products (Expected ${test.expectedMin}+) - ${test.description}`);
      results.failures.push({
        query: test.query,
        description: test.description,
        found: products.length,
        expected: test.expectedMin,
        category: test.category
      });
    }
  });

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${results.passed}/${testCases.length} (${Math.round(results.passed/testCases.length*100)}%)`);
  console.log(`❌ Failed: ${results.failed}/${testCases.length} (${Math.round(results.failed/testCases.length*100)}%)`);

  if (results.failures.length > 0) {
    console.log('\n❌ FAILED TESTS:');
    results.failures.forEach((failure, idx) => {
      console.log(`\n${idx + 1}. Query: "${failure.query}" (${failure.description})`);
      console.log(`   Expected: ${failure.expected}+ products in category: ${failure.category}`);
      console.log(`   Found: ${failure.found} products`);

      // Try to find why it failed
      const matches = productsData.filter(p =>
        p.category.toLowerCase().includes(failure.category.toLowerCase())
      );
      if (matches.length > 0) {
        console.log(`   ℹ️  Available in category: ${matches.length} products`);
        console.log(`   Sample: ${matches[0].name}`);
        console.log(`   Tags: ${matches[0].tags}`);
        console.log(`   Aliases: ${matches[0].aliases}`);
      }
    });
  }

  console.log('\n' + '='.repeat(60));

  return results;
}

// Run the tests
runTests();
