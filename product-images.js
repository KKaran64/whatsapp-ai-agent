// Product Image Database - Condensed
const PRODUCT_IMAGES = {
  // Coasters
  "4 piece cork coasters": "https://9cork.com/wp-content/uploads/2023/12/DSC05667-1024x683.jpg",
  "large grain cork coasters": "https://9cork.com/wp-content/uploads/2023/12/DSC05922-1024x683.jpg",
  "natural cork coasters": "https://9cork.com/wp-content/uploads/2023/12/DSC06226-1024x684.jpg",
  "square bridge cork coasters": "https://9cork.com/wp-content/uploads/2023/12/DSC06352-1024x684.jpg",
  "button style cork coasters": "https://9cork.com/wp-content/uploads/2023/12/DSC08482-1024x683.jpg",
  "cork trivet mat": "https://9cork.com/wp-content/uploads/2024/05/DSC05803-1.jpg",
  "cork coaster set": "https://9cork.com/wp-content/uploads/2024/05/DSC04953-1-1024x683.jpg",
  "square striped cork coaster": "https://9cork.com/wp-content/uploads/2024/05/DSC04758-1-1024x683.jpg",
  "heart coasters": "https://9cork.com/wp-content/uploads/2023/12/DSC05667-1024x683.jpg",
  "leaf coasters": "https://9cork.com/wp-content/uploads/2023/12/DSC06226-1024x684.jpg",

  // Desktop Accessories
  "cork diary": "https://9cork.com/wp-content/uploads/2024/04/img_0004_DSC06108.jpg",
  "cork desk calendar": "https://9cork.com/wp-content/uploads/2024/04/img_0000_DSC05846.jpg",
  "cork pen holder": "https://9cork.com/wp-content/uploads/2024/04/img_0006_DSC06108.jpg",
  "cork pen stand": "https://9cork.com/wp-content/uploads/2024/04/img_0001_DSC04807.jpg",
  "cork desk mat": "https://9cork.com/wp-content/uploads/2024/04/img_0002_DSC04828.jpg",
  "cork desk organizer": "https://9cork.com/wp-content/uploads/2023/12/DSC08781-1024x683.jpg",
  "cork pen and card holder": "https://9cork.com/wp-content/uploads/2023/12/DSC08971-1024x683.jpg",
  "3 in 1 organizer": "https://9cork.com/wp-content/uploads/2023/12/DSC08961-1024x683.jpg",
  "cork organizer tray": "https://9cork.com/wp-content/uploads/2024/04/DSC08981-1024x684.webp",
  "cork oval organizer": "https://9cork.com/wp-content/uploads/2023/12/DSC08917-1024x683.jpg",

  // Bags & Wallets
  "cork card holder": "https://9cork.com/wp-content/uploads/2023/12/DSC09266-1024x683.jpg",
  "cork wallet for men": "https://9cork.com/wp-content/uploads/2023/12/DSC09256-1024x683.jpg",
  "cork passport holder": "https://9cork.com/wp-content/uploads/2023/12/DSC09244-1024x683.jpg",
  "cork laptop bag": "https://9cork.com/wp-content/uploads/2023/12/DSC09172-1024x683.jpg",
  "laptop bag": "https://9cork.com/wp-content/uploads/2023/12/DSC09172-1024x683.jpg",
  "13 laptop bag": "https://9cork.com/wp-content/uploads/2023/12/DSC09172-1024x683.jpg",
  "15 laptop bag": "https://9cork.com/wp-content/uploads/2023/12/DSC09172-1024x683.jpg",
  "cork wallet for women": "https://9cork.com/wp-content/uploads/2023/12/DSC06368-1024x683.jpg",
  "cork wallet": "https://9cork.com/wp-content/uploads/2023/12/DSC05918-1024x683.jpg",

  // Planters
  "test tube planter": "https://9cork.com/wp-content/uploads/2023/12/U-Shaped-Planter-1024x683.jpg",
  "fridge magnet planter": "https://9cork.com/wp-content/uploads/2023/12/Small-Fridge-Magnet-1024x683.jpg",
  "round cork planter": "https://9cork.com/wp-content/uploads/2023/12/Round-Planter-1024x683.jpg",
  "cork test tube planter": "https://9cork.com/wp-content/uploads/2023/12/DSC08998-1024x683.jpg",
  "cork multicolored planter": "https://9cork.com/wp-content/uploads/2023/12/Diamond-Print-1024x769.jpg",
  "choco chip cork planter": "https://9cork.com/wp-content/uploads/2023/12/Chocochip-Texture-1024x683.jpg",

  // Serving Decor
  "cork table mat": "https://9cork.com/wp-content/uploads/2023/12/MAIN-IMAGE-1024x767.jpeg",
  "cork serving tray": "https://9cork.com/wp-content/uploads/2023/12/IMG_5575-1024x682.jpg",
  "olive cork table mat": "https://9cork.com/wp-content/uploads/2023/12/IMG_0465-1024x683.jpg",
  "natural cork table mat": "https://9cork.com/wp-content/uploads/2023/12/IMG_0459-1024x683.jpg",
  "cork tray": "https://9cork.com/wp-content/uploads/2023/12/DSC07580-1024x684.jpg",

  // Tea Lights
  "cork tea light holder": "https://9cork.com/wp-content/uploads/2024/04/img_0008_DSC09319-1.jpg",
  "cork tea light set": "https://9cork.com/wp-content/uploads/2024/04/img_0006_DSC04617.jpg",
  "cork cube tea light": "https://9cork.com/wp-content/uploads/2024/04/img_0007_DSC04613.jpg"
};

// Smart product matching - finds closest match
function findProductImage(productName) {
  const search = productName.toLowerCase().trim();

  // Direct match
  if (PRODUCT_IMAGES[search]) return PRODUCT_IMAGES[search];

  // Fuzzy match - find best keyword overlap
  let bestMatch = null;
  let bestScore = 0;

  for (const [name, url] of Object.entries(PRODUCT_IMAGES)) {
    const keywords = search.split(/\s+/).filter(w => w.length > 3);
    const score = keywords.filter(k => name.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = url;
    }
  }

  return bestScore >= 2 ? bestMatch : null;
}

module.exports = { PRODUCT_IMAGES, findProductImage };
