// Enhanced Product Image System - V2
// Uses structured JSON database for robust image management

const fs = require('fs');
const path = require('path');

// Load product database
let productDB = null;
try {
  const dbPath = path.join(__dirname, 'product-image-database.json');
  productDB = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  console.log(`✅ Loaded product database: ${productDB.metadata.totalProducts} products across ${productDB.metadata.totalCategories} categories`);
} catch (error) {
  console.error('❌ Failed to load product database:', error.message);
  productDB = { categories: {}, fallbackImages: {} };
}

// Validate URL is from official cork domain
function isValidCorkProductUrl(url) {
  return url && url.startsWith('https://9cork.com/');
}

// Normalize search text for better matching
function normalizeText(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' '); // Normalize whitespace
}

// Extract keywords from search text
function extractKeywords(text) {
  const normalized = normalizeText(text);
  return normalized
    .split(' ')
    .filter(word => word.length > 2) // Filter out very short words
    .filter(word => !['the', 'and', 'for', 'with'].includes(word)); // Remove stop words
}

// Calculate match score between search text and product
function calculateMatchScore(searchKeywords, product) {
  let score = 0;
  const searchText = searchKeywords.join(' ');

  // Check exact name match (highest priority)
  if (normalizeText(product.name).includes(searchText)) {
    score += 100;
  }

  // Check aliases
  for (const alias of product.aliases || []) {
    if (normalizeText(alias).includes(searchText)) {
      score += 50;
    }
    // Check individual keyword matches in aliases
    for (const keyword of searchKeywords) {
      if (normalizeText(alias).includes(keyword)) {
        score += 10;
      }
    }
  }

  // Check tags
  for (const tag of product.tags || []) {
    if (searchKeywords.includes(normalizeText(tag))) {
      score += 20;
    }
  }

  // Check individual keywords in product name
  for (const keyword of searchKeywords) {
    if (normalizeText(product.name).includes(keyword)) {
      score += 5;
    }
  }

  return score;
}

// Find best matching product(s) for search query
function findProductImage(searchQuery) {
  if (!productDB || !productDB.categories) {
    console.log('⚠️ Product database not loaded');
    return null;
  }

  const searchKeywords = extractKeywords(searchQuery);
  if (searchKeywords.length === 0) {
    console.log('⚠️ No valid keywords extracted from search query');
    return null;
  }

  console.log(`🔍 Searching for: "${searchQuery}" | Keywords: [${searchKeywords.join(', ')}]`);

  let bestMatch = null;
  let bestScore = 0;
  let bestCategory = null;

  // Search across all categories
  for (const [categoryKey, category] of Object.entries(productDB.categories)) {
    // Check if category keywords match
    const categoryMatch = (category.keywords || []).some(kw =>
      searchKeywords.some(sk => normalizeText(kw).includes(sk) || sk.includes(normalizeText(kw)))
    );

    const categoryBonus = categoryMatch ? 5 : 0;

    // Search products in this category
    for (const product of category.products || []) {
      const score = calculateMatchScore(searchKeywords, product) + categoryBonus;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = product;
        bestCategory = categoryKey;
      }
    }
  }

  // Require minimum score for match
  const minScore = searchKeywords.length === 1 ? 10 : 15;

  if (bestScore >= minScore && bestMatch) {
    const imageUrl = bestMatch.images && bestMatch.images.length > 0 ? bestMatch.images[0] : null;

    if (imageUrl && isValidCorkProductUrl(imageUrl)) {
      console.log(`✅ Match found: "${bestMatch.name}" (Category: ${bestCategory}, Score: ${bestScore})`);
      return imageUrl;
    }
  }

  console.log(`⚠️ No match found for "${searchQuery}" (Best score: ${bestScore}, Min required: ${minScore})`);
  return null;
}

// Get multiple images for a category
function getCatalogImages(categoryQuery) {
  if (!productDB || !productDB.categories) {
    console.log('⚠️ Product database not loaded');
    return [];
  }

  const searchKeywords = extractKeywords(categoryQuery);
  console.log(`📁 Fetching catalog for: "${categoryQuery}" | Keywords: [${searchKeywords.join(', ')}]`);

  // Find matching category
  for (const [categoryKey, category] of Object.entries(productDB.categories)) {
    const categoryMatch = (category.keywords || []).some(kw =>
      searchKeywords.some(sk => normalizeText(kw) === normalizeText(sk) || normalizeText(kw).includes(normalizeText(sk)))
    );

    if (categoryMatch) {
      const images = [];
      const limit = 6; // Maximum 6 images per category

      for (const product of (category.products || []).slice(0, limit)) {
        if (product.images && product.images.length > 0) {
          const imageUrl = product.images[0];
          if (isValidCorkProductUrl(imageUrl)) {
            images.push(imageUrl);
          }
        }
      }

      if (images.length > 0) {
        console.log(`✅ Found ${images.length} images for category: ${category.displayName}`);
        return images;
      }
    }
  }

  // Fallback: return generic category images
  console.log(`⚠️ No specific category match, using fallback images`);
  return Object.values(productDB.fallbackImages || {})
    .filter(url => isValidCorkProductUrl(url))
    .slice(0, 6);
}

// Get product info (for future features - product details, pricing, etc.)
function getProductInfo(productQuery) {
  if (!productDB || !productDB.categories) {
    return null;
  }

  const searchKeywords = extractKeywords(productQuery);
  let bestMatch = null;
  let bestScore = 0;

  for (const category of Object.values(productDB.categories)) {
    for (const product of category.products || []) {
      const score = calculateMatchScore(searchKeywords, product);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = product;
      }
    }
  }

  return bestScore >= 10 ? bestMatch : null;
}

// Stats endpoint for debugging
function getDatabaseStats() {
  if (!productDB || !productDB.categories) {
    return { error: 'Database not loaded' };
  }

  const stats = {
    totalCategories: Object.keys(productDB.categories).length,
    totalProducts: 0,
    totalImages: 0,
    categoriesBreakdown: {}
  };

  for (const [categoryKey, category] of Object.entries(productDB.categories)) {
    const productsCount = (category.products || []).length;
    const imagesCount = (category.products || []).reduce((sum, p) => sum + (p.images || []).length, 0);

    stats.totalProducts += productsCount;
    stats.totalImages += imagesCount;
    stats.categoriesBreakdown[categoryKey] = {
      name: category.displayName,
      products: productsCount,
      images: imagesCount
    };
  }

  return stats;
}

module.exports = {
  findProductImage,
  getCatalogImages,
  getProductInfo,
  isValidCorkProductUrl,
  getDatabaseStats
};
