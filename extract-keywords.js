const db = require('./product-image-database.json');
const keywords = new Set();

// Extract all unique keywords from categories and products
for (const [catKey, category] of Object.entries(db.categories)) {
  // Add category keywords
  category.keywords?.forEach(kw => {
    kw.split(/\s+/).forEach(word => {
      if (word.length > 2) keywords.add(word.toLowerCase());
    });
  });

  // Add product names, aliases, and tags
  category.products?.forEach(product => {
    // From name
    product.name.split(/\s+/).forEach(word => {
      const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.length > 2 && clean !== 'cork') keywords.add(clean);
    });

    // From aliases
    product.aliases?.forEach(alias => {
      alias.split(/\s+/).forEach(word => {
        const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (clean.length > 2 && clean !== 'cork') keywords.add(clean);
      });
    });

    // From tags
    product.tags?.forEach(tag => {
      const clean = tag.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.length > 2 && clean !== 'cork') keywords.add(clean);
    });
  });
}

console.log(Array.from(keywords).sort().join('|'));
