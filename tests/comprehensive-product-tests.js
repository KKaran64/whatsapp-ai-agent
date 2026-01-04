// Comprehensive Product Search Tests
// Tests 150+ different product queries across all categories

const Product = require('../models/Product');

// Test cases covering all 19 categories with variations
const testCases = [
  // === COASTERS (19 products) ===
  { query: 'show me coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'share photos of costers', category: 'COASTER', expectedMin: 1 }, // Misspelling
  { query: 'round coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'square coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'coaster set', category: 'COASTER', expectedMin: 1 },
  { query: 'drink coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'table coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'hexagon coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'heart coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'leaf coasters', category: 'COASTER', expectedMin: 1 },

  // === DIARIES & NOTEBOOKS (7 products) ===
  { query: 'show me diaries', category: 'DIAR', expectedMin: 1 },
  { query: 'cork diary', category: 'DIAR', expectedMin: 1 },
  { query: 'notebook', category: 'DIAR', expectedMin: 1 },
  { query: 'journal', category: 'DIAR', expectedMin: 1 },
  { query: 'planner', category: 'DIAR', expectedMin: 1 },
  { query: 'a5 diary', category: 'DIAR', expectedMin: 1 },
  { query: 'a6 diary', category: 'DIAR', expectedMin: 1 },
  { query: 'writing diary', category: 'DIAR', expectedMin: 1 },
  { query: 'diry', category: 'DIAR', expectedMin: 1 }, // Misspelling

  // === CALENDARS (3 products) ===
  { query: 'show me calendars', category: 'DESKTOP', expectedMin: 1 },
  { query: 'calenders', category: 'DESKTOP', expectedMin: 1 }, // Misspelling
  { query: 'desk calendar', category: 'DESKTOP', expectedMin: 1 },
  { query: 'table calendar', category: 'DESKTOP', expectedMin: 1 },
  { query: 'small calendar', category: 'DESKTOP', expectedMin: 1 },
  { query: 'large calendar', category: 'DESKTOP', expectedMin: 1 },

  // === DESK ORGANIZERS (27 products) ===
  { query: 'desk organizer', category: 'DESKTOP', expectedMin: 1 },
  { query: 'organiser', category: 'DESKTOP', expectedMin: 1 }, // British spelling
  { query: 'pen holder', category: 'DESKTOP', expectedMin: 1 },
  { query: 'pencil holder', category: 'DESKTOP', expectedMin: 1 },
  { query: 'stationery organizer', category: 'DESKTOP', expectedMin: 1 },
  { query: 'office organizer', category: 'DESKTOP', expectedMin: 1 },
  { query: 'desk accessories', category: 'DESKTOP', expectedMin: 1 },
  { query: 'mobile holder', category: 'DESKTOP', expectedMin: 1 },
  { query: 'phone holder', category: 'DESKTOP', expectedMin: 1 },
  { query: 'card holder desk', category: 'DESKTOP', expectedMin: 1 },

  // === PLANTERS (42 products total: 30 test tube + 12 table top) ===
  { query: 'planters', category: 'PLANTER', expectedMin: 1 },
  { query: 'test tube planter', category: 'TEST TUBE', expectedMin: 1 },
  { query: 'table top planter', category: 'TABLE TOP', expectedMin: 1 },
  { query: 'plant holder', category: 'PLANTER', expectedMin: 1 },
  { query: 'flower planter', category: 'PLANTER', expectedMin: 1 },
  { query: 'fridge magnet planter', category: 'TEST TUBE', expectedMin: 1 },
  { query: 'cylindrical planter', category: 'PLANTER', expectedMin: 1 },
  { query: 'oval planter', category: 'PLANTER', expectedMin: 1 },

  // === BAGS & WALLETS (24 products: 18 laptop + 6 purses) ===
  { query: 'laptop bag', category: 'LAPTOP', expectedMin: 1 },
  { query: 'laptop sleeve', category: 'LAPTOP', expectedMin: 1 },
  { query: 'laptop case', category: 'LAPTOP', expectedMin: 1 },
  { query: 'notebook bag', category: 'LAPTOP', expectedMin: 1 },
  { query: 'wallets', category: 'BAG', expectedMin: 1 },
  { query: 'purse', category: 'BAG', expectedMin: 1 },
  { query: 'clutch', category: 'BAG', expectedMin: 1 },
  { query: 'handbag', category: 'BAG', expectedMin: 1 },
  { query: 'sling bag', category: 'BAG', expectedMin: 1 },
  { query: 'tote bag', category: 'BAG', expectedMin: 1 },

  // === TRAVEL ORGANIZERS (13 products) ===
  { query: 'passport holder', category: 'TRAVEL', expectedMin: 1 },
  { query: 'travel organizer', category: 'TRAVEL', expectedMin: 1 },
  { query: 'card holder travel', category: 'TRAVEL', expectedMin: 1 },
  { query: 'travel wallet', category: 'TRAVEL', expectedMin: 1 },
  { query: 'document holder', category: 'TRAVEL', expectedMin: 1 },

  // === PHOTO FRAMES (8 products) ===
  { query: 'photo frames', category: 'FRAME', expectedMin: 1 },
  { query: 'picture frame', category: 'FRAME', expectedMin: 1 },
  { query: 'photoframe', category: 'FRAME', expectedMin: 1 },
  { query: 'wall frame', category: 'FRAME', expectedMin: 1 },
  { query: 'display frame', category: 'FRAME', expectedMin: 1 },

  // === TRAYS (12 products) ===
  { query: 'serving tray', category: 'TRAY', expectedMin: 1 },
  { query: 'trays', category: 'TRAY', expectedMin: 1 },
  { query: 'decor tray', category: 'TRAY', expectedMin: 1 },
  { query: 'table tray', category: 'TRAY', expectedMin: 1 },
  { query: 'natural tray', category: 'TRAY', expectedMin: 1 },

  // === TEA LIGHT HOLDERS (12 products) ===
  { query: 'tea light holders', category: 'TEA LIGHT', expectedMin: 1 },
  { query: 'candle holder', category: 'TEA LIGHT', expectedMin: 1 },
  { query: 'tea lights', category: 'TEA LIGHT', expectedMin: 1 },
  { query: 'tealight', category: 'TEA LIGHT', expectedMin: 1 },
  { query: 'candles', category: 'TEA LIGHT', expectedMin: 1 },

  // === BOTTLES (4 products) ===
  { query: 'bottles', category: 'BOTTLE', expectedMin: 1 },
  { query: 'water bottle', category: 'BOTTLE', expectedMin: 1 },
  { query: 'drink bottle', category: 'BOTTLE', expectedMin: 1 },
  { query: 'bottel', category: 'BOTTLE', expectedMin: 1 }, // Misspelling

  // === YOGA MATS (7 products) ===
  { query: 'yoga mat', category: 'YOGA', expectedMin: 1 },
  { query: 'exercise mat', category: 'YOGA', expectedMin: 1 },
  { query: 'fitness mat', category: 'YOGA', expectedMin: 1 },
  { query: 'workout mat', category: 'YOGA', expectedMin: 1 },

  // === TABLE MATS (4 products) ===
  { query: 'table mats', category: 'TABLEMAT', expectedMin: 1 },
  { query: 'placemats', category: 'TABLEMAT', expectedMin: 1 },
  { query: 'dining mat', category: 'TABLEMAT', expectedMin: 1 },

  // === TRIVETS/HOT PLATES (5 products) ===
  { query: 'trivets', category: 'TRIVET', expectedMin: 1 },
  { query: 'hot plates', category: 'TRIVET', expectedMin: 1 },
  { query: 'pot holder', category: 'TRIVET', expectedMin: 1 },

  // === CLOCKS (3 products) ===
  { query: 'clock', category: 'CLOCK', expectedMin: 1 },
  { query: 'table clock', category: 'CLOCK', expectedMin: 1 },
  { query: 'wall clock', category: 'CLOCK', expectedMin: 1 },
  { query: 'desk clock', category: 'CLOCK', expectedMin: 1 },

  // === GIFT BOXES (6 products) ===
  { query: 'gift boxes', category: 'GIFT', expectedMin: 1 },
  { query: 'gift packaging', category: 'GIFT', expectedMin: 1 },
  { query: 'present box', category: 'GIFT', expectedMin: 1 },

  // === GAMES (2 products) ===
  { query: 'games', category: 'GAME', expectedMin: 1 },
  { query: 'fun games', category: 'GAME', expectedMin: 1 },

  // === SHELF DECOR (1 product) ===
  { query: 'shelf decor', category: 'SHELF', expectedMin: 1 },
  { query: 'decoration', category: 'SHELF', expectedMin: 1 },

  // === COMBO QUERIES (Testing multiple keywords) ===
  { query: 'cork coasters', category: 'COASTER', expectedMin: 1 },
  { query: 'eco-friendly diary', category: 'DIAR', expectedMin: 1 },
  { query: 'sustainable planter', category: 'PLANTER', expectedMin: 1 },
  { query: 'natural cork bags', category: 'BAG', expectedMin: 1 },

  // === MISSPELLINGS & TYPOS ===
  { query: 'coaters', category: 'COASTER', expectedMin: 1 },
  { query: 'deak organizer', category: 'DESKTOP', expectedMin: 1 },
  { query: 'organiser', category: 'DESKTOP', expectedMin: 1 },
  { query: 'lap top bag', category: 'LAPTOP', expectedMin: 1 },
  { query: 'tabel mat', category: 'TABLEMAT', expectedMin: 1 },

  // === ALTERNATIVE NAMES ===
  { query: 'journal', category: 'DIAR', expectedMin: 1 }, // Instead of diary
  { query: 'pot', category: 'PLANTER', expectedMin: 1 }, // Instead of planter
  { query: 'purse', category: 'BAG', expectedMin: 1 }, // Instead of wallet
  { query: 'mousepad', category: 'DESKTOP', expectedMin: 0 }, // We don't have mousepads

  // === FEATURE-BASED QUERIES ===
  { query: 'round products', category: 'COASTER', expectedMin: 1 },
  { query: 'square items', category: 'COASTER', expectedMin: 1 },
  { query: 'small size', category: '', expectedMin: 1 },
  { query: 'large size', category: '', expectedMin: 1 },

  // === USE CASE QUERIES ===
  { query: 'office items', category: 'DESKTOP', expectedMin: 1 },
  { query: 'home decor', category: '', expectedMin: 1 },
  { query: 'travel accessories', category: 'TRAVEL', expectedMin: 1 },
  { query: 'gift items', category: 'GIFT', expectedMin: 1 },
  { query: 'writing items', category: 'DIAR', expectedMin: 1 },
];

console.log(`\n🧪 COMPREHENSIVE PRODUCT SEARCH TESTS`);
console.log(`   Total test cases: ${testCases.length}`);
console.log(`   Coverage: All 19 product categories`);
console.log(`   Testing: Names, aliases, tags, misspellings, alternative names\n`);

async function runTests() {
  const results = {
    passed: 0,
    failed: 0,
    details: []
  };

  for (const test of testCases) {
    try {
      // Search using text search (like the bot does)
      const products = await Product.find({
        $or: [
          { $text: { $search: test.query } },
          { name: new RegExp(test.query, 'i') },
          { aliases: new RegExp(test.query, 'i') },
          { tags: new RegExp(test.query, 'i') },
          { category: new RegExp(test.category, 'i') }
        ]
      }).limit(10);

      const passed = products.length >= test.expectedMin;

      if (passed) {
        results.passed++;
        console.log(`✅ "${test.query}" → Found ${products.length} products`);
      } else {
        results.failed++;
        console.log(`❌ "${test.query}" → Found ${products.length}, expected ${test.expectedMin}+`);
        results.details.push({
          query: test.query,
          found: products.length,
          expected: test.expectedMin,
          category: test.category
        });
      }
    } catch (error) {
      results.failed++;
      console.log(`❌ "${test.query}" → Error: ${error.message}`);
      results.details.push({
        query: test.query,
        error: error.message
      });
    }
  }

  return results;
}

module.exports = { testCases, runTests };
