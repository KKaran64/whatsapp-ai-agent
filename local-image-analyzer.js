// Local Image Analyzer - No External APIs Required
// Uses sharp for image processing + perceptual hashing for product matching
// v53.39: Alternative to Gemini/Claude when API keys are unavailable

const sharp = require('sharp');
const crypto = require('crypto');

class LocalImageAnalyzer {
  constructor() {
    // Product image hashes cache (loaded from DB on first use)
    this.productHashes = new Map();
    this.hashesLoaded = false;

    // Cork product color signatures (HSL ranges)
    this.corkColors = {
      natural: { h: [20, 40], s: [30, 70], l: [40, 70] },    // Natural cork tan
      dark: { h: [15, 35], s: [40, 80], l: [20, 45] },       // Dark cork brown
      light: { h: [25, 50], s: [20, 50], l: [60, 85] }       // Light cork beige
    };

    // Product shape signatures
    this.productShapes = {
      coaster: { aspectRatio: [0.85, 1.15], keywords: ['round', 'circle', 'hexagon'] },
      diary: { aspectRatio: [0.6, 0.8], keywords: ['book', 'notebook', 'rectangle'] },
      bag: { aspectRatio: [0.8, 1.5], keywords: ['bag', 'tote', 'handle'] },
      wallet: { aspectRatio: [1.5, 2.5], keywords: ['wallet', 'fold', 'card'] },
      planter: { aspectRatio: [0.5, 1.5], keywords: ['plant', 'tube', 'pot'] },
      frame: { aspectRatio: [0.7, 1.4], keywords: ['frame', 'photo', 'border'] }
    };

    console.log('🖼️ Local Image Analyzer initialized');
  }

  // Calculate perceptual hash (pHash) of an image
  async calculatePHash(imageBuffer) {
    try {
      // Resize to 32x32 grayscale for hashing
      const resized = await sharp(imageBuffer)
        .resize(32, 32, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer();

      // Calculate DCT-like hash (simplified)
      const pixels = Array.from(resized);
      const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length;

      // Create binary hash based on above/below average
      let hash = '';
      for (let i = 0; i < 64; i++) { // Use 8x8 = 64 bits
        hash += pixels[i * 16] > avg ? '1' : '0';
      }

      return hash;
    } catch (error) {
      console.error('❌ pHash calculation failed:', error.message);
      return null;
    }
  }

  // Calculate Hamming distance between two hashes
  hammingDistance(hash1, hash2) {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) return Infinity;

    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) distance++;
    }
    return distance;
  }

  // Extract dominant colors from image
  async extractDominantColors(imageBuffer) {
    try {
      // Get image stats
      const { dominant, channels } = await sharp(imageBuffer)
        .resize(100, 100, { fit: 'inside' })
        .stats();

      // Convert RGB to HSL
      const r = dominant.r / 255;
      const g = dominant.g / 255;
      const b = dominant.b / 255;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;

      let h = 0, s = 0;

      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

        switch (max) {
          case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
          case g: h = ((b - r) / d + 2) / 6; break;
          case b: h = ((r - g) / d + 4) / 6; break;
        }
      }

      return {
        rgb: { r: dominant.r, g: dominant.g, b: dominant.b },
        hsl: { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) },
        channels: channels.map(c => ({
          mean: Math.round(c.mean),
          std: Math.round(c.stdev)
        }))
      };
    } catch (error) {
      console.error('❌ Color extraction failed:', error.message);
      return null;
    }
  }

  // Check if colors match cork product signature
  isCorkProduct(colors) {
    if (!colors?.hsl) return { isCork: false, confidence: 0 };

    const { h, s, l } = colors.hsl;

    for (const [type, range] of Object.entries(this.corkColors)) {
      if (h >= range.h[0] && h <= range.h[1] &&
          s >= range.s[0] && s <= range.s[1] &&
          l >= range.l[0] && l <= range.l[1]) {
        return { isCork: true, corkType: type, confidence: 0.7 };
      }
    }

    // Partial match (just hue in range)
    if (h >= 15 && h <= 50) {
      return { isCork: true, corkType: 'possible', confidence: 0.4 };
    }

    return { isCork: false, confidence: 0 };
  }

  // Get image dimensions and aspect ratio
  async getImageMetadata(imageBuffer) {
    try {
      const metadata = await sharp(imageBuffer).metadata();

      return {
        width: metadata.width,
        height: metadata.height,
        aspectRatio: metadata.width / metadata.height,
        format: metadata.format,
        hasAlpha: metadata.hasAlpha,
        isSquare: Math.abs(metadata.width - metadata.height) < Math.min(metadata.width, metadata.height) * 0.15
      };
    } catch (error) {
      console.error('❌ Metadata extraction failed:', error.message);
      return null;
    }
  }

  // Guess product category based on aspect ratio and colors
  guessProductCategory(metadata, colors) {
    if (!metadata) return { category: 'unknown', confidence: 0 };

    const ar = metadata.aspectRatio;
    const guesses = [];

    // Check each product shape
    for (const [product, shape] of Object.entries(this.productShapes)) {
      if (ar >= shape.aspectRatio[0] && ar <= shape.aspectRatio[1]) {
        let confidence = 0.3;

        // Boost confidence for square images (likely coasters)
        if (product === 'coaster' && metadata.isSquare) {
          confidence = 0.6;
        }

        // Boost for portrait orientation (diaries, frames)
        if ((product === 'diary' || product === 'frame') && ar < 1) {
          confidence = 0.5;
        }

        // Boost for wide images (wallets, bags)
        if ((product === 'wallet' || product === 'bag') && ar > 1.2) {
          confidence = 0.5;
        }

        guesses.push({ category: product, confidence });
      }
    }

    // Sort by confidence
    guesses.sort((a, b) => b.confidence - a.confidence);

    return guesses[0] || { category: 'unknown', confidence: 0 };
  }

  // Detect if image contains a logo (high contrast, simple shapes)
  async detectLogo(imageBuffer) {
    try {
      const stats = await sharp(imageBuffer)
        .resize(100, 100, { fit: 'inside' })
        .stats();

      // High contrast images often indicate logos
      const avgStd = stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length;

      // Check for limited color palette (logos tend to have few colors)
      const colorVariance = stats.channels.reduce((sum, c) => sum + c.stdev, 0);

      return {
        isLikeLogo: avgStd > 60 || colorVariance < 100,
        confidence: avgStd > 80 ? 0.7 : avgStd > 60 ? 0.5 : 0.3
      };
    } catch (error) {
      return { isLikeLogo: false, confidence: 0 };
    }
  }

  // Main analysis function
  async analyzeImage(imageBuffer) {
    console.log('🔍 Analyzing image locally...');

    const [metadata, colors, logoDetection, pHash] = await Promise.all([
      this.getImageMetadata(imageBuffer),
      this.extractDominantColors(imageBuffer),
      this.detectLogo(imageBuffer),
      this.calculatePHash(imageBuffer)
    ]);

    // Check if it's a cork product
    const corkCheck = this.isCorkProduct(colors);

    // Guess product category
    const categoryGuess = this.guessProductCategory(metadata, colors);

    // Combine analysis
    const analysis = {
      metadata,
      colors,
      corkCheck,
      categoryGuess,
      logoDetection,
      pHash,
      timestamp: new Date().toISOString()
    };

    console.log('📊 Analysis complete:', {
      isCork: corkCheck.isCork,
      corkType: corkCheck.corkType,
      category: categoryGuess.category,
      isLogo: logoDetection.isLikeLogo,
      aspectRatio: metadata?.aspectRatio?.toFixed(2)
    });

    return analysis;
  }

  // Generate response based on local analysis
  generateResponse(analysis, userMessage = '') {
    const { corkCheck, categoryGuess, logoDetection, metadata } = analysis;

    // Priority 1: Logo/design detected
    if (logoDetection.isLikeLogo && logoDetection.confidence > 0.5) {
      return {
        type: 'logo',
        response: "I see you've shared a logo/design! I can customize this on cork products. Is this for corporate branding or a personal gift? And which product interests you - coasters, diaries, or something else?",
        confidence: logoDetection.confidence
      };
    }

    // Priority 2: Cork product identified
    if (corkCheck.isCork && corkCheck.confidence > 0.5) {
      const categoryName = this.getCategoryDisplayName(categoryGuess.category);

      if (categoryGuess.confidence > 0.4) {
        return {
          type: 'product',
          response: `This looks like a cork ${categoryName}! How many pieces do you need, and is this for personal use or corporate gifting?`,
          confidence: corkCheck.confidence * categoryGuess.confidence,
          detectedCategory: categoryGuess.category
        };
      }

      return {
        type: 'cork_unknown',
        response: "I can see this is a cork product! Could you tell me which specific item you're interested in - coasters, diaries, bags, or something else?",
        confidence: corkCheck.confidence
      };
    }

    // Priority 3: Non-cork reference image
    if (metadata && !corkCheck.isCork) {
      return {
        type: 'reference',
        response: "Thanks for the reference image! Which cork product would you like this design on? We have coasters, diaries, bags, planters, and more.",
        confidence: 0.5
      };
    }

    // Fallback
    return {
      type: 'unclear',
      response: "I received your image! Could you tell me what you're looking for? Are you interested in cork coasters, diaries, bags, or customized corporate gifts?",
      confidence: 0.3
    };
  }

  // Get display name for category
  getCategoryDisplayName(category) {
    const names = {
      coaster: 'coaster',
      diary: 'diary/notebook',
      bag: 'bag',
      wallet: 'wallet/card holder',
      planter: 'planter',
      frame: 'photo frame',
      unknown: 'product'
    };
    return names[category] || 'product';
  }

  // Load product image hashes from database
  async loadProductHashes(Product) {
    if (this.hashesLoaded) return;

    try {
      console.log('📦 Loading product image hashes...');
      const products = await Product.find({ images: { $exists: true, $ne: [] } });

      for (const product of products) {
        if (product.images && product.images.length > 0) {
          // Store product info for matching
          this.productHashes.set(product.productId, {
            name: product.name,
            category: product.category,
            images: product.images,
            hash: null // Will be computed on first match attempt
          });
        }
      }

      this.hashesLoaded = true;
      console.log(`✅ Loaded ${this.productHashes.size} products for matching`);
    } catch (error) {
      console.error('❌ Failed to load product hashes:', error.message);
    }
  }

  // Match image against product database
  async matchAgainstProducts(imageBuffer, Product) {
    // Ensure hashes are loaded
    await this.loadProductHashes(Product);

    const inputHash = await this.calculatePHash(imageBuffer);
    if (!inputHash) return null;

    // Note: Full matching would require downloading and hashing product images
    // For now, return analysis-based match
    return null;
  }
}

module.exports = LocalImageAnalyzer;
