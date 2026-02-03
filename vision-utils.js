// Vision Utilities - Shared functions for image analysis
// v54.0: Consolidated from LocalImageAnalyzer and SmartImageMatcher

const sharp = require('sharp');

// Cork color signatures (both RGB and HSL for different use cases)
const CORK_COLORS = {
  rgb: {
    natural: { r: [150, 200], g: [120, 160], b: [70, 120] },
    dark: { r: [100, 150], g: [70, 120], b: [40, 90] },
    light: { r: [180, 230], g: [150, 200], b: [100, 150] }
  },
  hsl: {
    natural: { h: [20, 40], s: [30, 70], l: [40, 70] },
    dark: { h: [15, 35], s: [40, 80], l: [20, 45] },
    light: { h: [25, 50], s: [20, 50], l: [60, 85] }
  }
};

// Product category keywords for CLIP-like matching
const CATEGORY_KEYWORDS = {
  coaster: ['coaster', 'round', 'drink', 'cup', 'mat', 'hexagon', 'heart', 'leaf'],
  diary: ['diary', 'notebook', 'journal', 'book', 'pages', 'writing', 'a5', 'a6'],
  organizer: ['organizer', 'desk', 'pen', 'holder', 'storage', 'office', 'compartment'],
  cardholder: ['card', 'holder', 'wallet', 'credit', 'business', 'pocket'],
  planter: ['planter', 'plant', 'pot', 'flower', 'tube', 'green', 'garden'],
  bag: ['bag', 'tote', 'handbag', 'laptop', 'sleeve', 'carry'],
  wallet: ['wallet', 'bifold', 'trifold', 'money', 'cash', 'leather'],
  frame: ['frame', 'photo', 'picture', 'border', 'display'],
  clock: ['clock', 'time', 'watch', 'wall', 'round'],
  mousepad: ['mousepad', 'mouse', 'pad', 'desk', 'computer'],
  yogamat: ['yoga', 'mat', 'exercise', 'fitness', 'roll']
};

// Product shape signatures for aspect ratio matching
const PRODUCT_SHAPES = {
  coaster: { aspectRatio: [0.85, 1.15], boost: 0.4 },
  diary: { aspectRatio: [0.6, 0.8], boost: 0.4 },
  frame: { aspectRatio: [0.7, 1.4], boost: 0.3 },
  wallet: { aspectRatio: [1.5, 2.5], boost: 0.3 },
  mousepad: { aspectRatio: [1.2, 2.0], boost: 0.3 },
  bag: { aspectRatio: [0.8, 1.5], boost: 0.2 }
};

/**
 * Calculate perceptual hash (pHash) using DCT-based approach
 * More robust than simple average-based hashing
 */
async function calculatePHash(imageBuffer) {
  try {
    const resized = await sharp(imageBuffer)
      .resize(32, 32, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    const pixels = Array.from(resized);
    const gridSize = 8;
    const blockSize = 4;
    const dctValues = [];

    // Calculate block averages (simplified DCT)
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        let sum = 0;
        for (let by = 0; by < blockSize; by++) {
          for (let bx = 0; bx < blockSize; bx++) {
            const idx = (y * blockSize + by) * 32 + (x * blockSize + bx);
            sum += pixels[idx];
          }
        }
        dctValues.push(sum / (blockSize * blockSize));
      }
    }

    // Calculate average (excluding DC component)
    const avg = dctValues.slice(1).reduce((a, b) => a + b, 0) / (dctValues.length - 1);

    // Generate 64-bit hash
    return dctValues.map(v => v > avg ? '1' : '0').join('');
  } catch (error) {
    console.error('❌ pHash calculation failed:', error.message);
    return null;
  }
}

/**
 * Calculate Hamming distance between two binary hash strings
 */
function hammingDistance(hash1, hash2) {
  // Handle null/undefined
  if (hash1 == null || hash2 == null) return Infinity;
  // Handle different lengths (but allow empty strings to match)
  if (hash1.length !== hash2.length) return Infinity;
  // Two empty strings are identical (distance 0)
  if (hash1.length === 0) return 0;

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) distance++;
  }
  return distance;
}

/**
 * Extract comprehensive image features for analysis
 */
async function extractImageFeatures(imageBuffer) {
  try {
    const [metadata, stats, histogram] = await Promise.all([
      sharp(imageBuffer).metadata(),
      sharp(imageBuffer).stats(),
      getColorHistogram(imageBuffer)
    ]);

    const aspectRatio = metadata.width / metadata.height;
    const dominant = stats.dominant;

    // Determine shape classification
    let shape = 'unknown';
    if (aspectRatio >= 0.9 && aspectRatio <= 1.1) shape = 'square';
    else if (aspectRatio < 0.9) shape = 'portrait';
    else shape = 'landscape';

    // Check cork color match
    const corkMatch = isCorkColor(dominant);

    // Calculate edge complexity
    const edges = await detectEdges(imageBuffer);

    // Convert dominant RGB to HSL
    const hsl = rgbToHsl(dominant.r, dominant.g, dominant.b);

    return {
      width: metadata.width,
      height: metadata.height,
      aspectRatio,
      shape,
      format: metadata.format,
      hasAlpha: metadata.hasAlpha,
      isSquare: Math.abs(metadata.width - metadata.height) < Math.min(metadata.width, metadata.height) * 0.15,
      dominant: { rgb: dominant, hsl },
      isCorkColored: corkMatch,
      histogram,
      edgeComplexity: edges.complexity,
      isSimple: edges.complexity < 0.3
    };
  } catch (error) {
    console.error('❌ Feature extraction failed:', error.message);
    return null;
  }
}

/**
 * Get color histogram (8 bins per channel)
 */
async function getColorHistogram(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer)
      .resize(50, 50, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const histogram = { r: new Array(8).fill(0), g: new Array(8).fill(0), b: new Array(8).fill(0) };
    const pixels = info.width * info.height;

    for (let i = 0; i < data.length; i += 3) {
      histogram.r[Math.floor(data[i] / 32)]++;
      histogram.g[Math.floor(data[i + 1] / 32)]++;
      histogram.b[Math.floor(data[i + 2] / 32)]++;
    }

    // Normalize
    for (let i = 0; i < 8; i++) {
      histogram.r[i] /= pixels;
      histogram.g[i] /= pixels;
      histogram.b[i] /= pixels;
    }

    return histogram;
  } catch (error) {
    return null;
  }
}

/**
 * Edge detection for complexity estimation
 */
async function detectEdges(imageBuffer) {
  try {
    const edges = await sharp(imageBuffer)
      .resize(100, 100, { fit: 'fill' })
      .grayscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] // Laplacian
      })
      .raw()
      .toBuffer();

    const pixels = Array.from(edges);
    const edgePixels = pixels.filter(p => p > 30).length;
    return { complexity: edgePixels / pixels.length, edgeCount: edgePixels };
  } catch (error) {
    return { complexity: 0.5, edgeCount: 0 };
  }
}

/**
 * Check if RGB color matches cork color signature
 */
function isCorkColor(rgb) {
  for (const [type, range] of Object.entries(CORK_COLORS.rgb)) {
    if (rgb.r >= range.r[0] && rgb.r <= range.r[1] &&
        rgb.g >= range.g[0] && rgb.g <= range.g[1] &&
        rgb.b >= range.b[0] && rgb.b <= range.b[1]) {
      return { isCork: true, type, confidence: 0.7 };
    }
  }
  return { isCork: false, type: null, confidence: 0 };
}

/**
 * Check if HSL color matches cork color signature
 */
function isCorkColorHSL(hsl) {
  for (const [type, range] of Object.entries(CORK_COLORS.hsl)) {
    if (hsl.h >= range.h[0] && hsl.h <= range.h[1] &&
        hsl.s >= range.s[0] && hsl.s <= range.s[1] &&
        hsl.l >= range.l[0] && hsl.l <= range.l[1]) {
      return { isCork: true, type, confidence: 0.7 };
    }
  }
  // Partial match (just hue in range)
  if (hsl.h >= 15 && hsl.h <= 50) {
    return { isCork: true, type: 'possible', confidence: 0.4 };
  }
  return { isCork: false, type: null, confidence: 0 };
}

/**
 * Convert RGB to HSL
 */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
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
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100)
  };
}

/**
 * Detect if image is likely a logo (high contrast, simple shapes)
 */
async function detectLogo(imageBuffer) {
  try {
    const stats = await sharp(imageBuffer)
      .resize(100, 100, { fit: 'inside' })
      .stats();

    const avgStd = stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length;
    const colorVariance = stats.channels.reduce((sum, c) => sum + c.stdev, 0);

    const isLikeLogo = avgStd > 60 || colorVariance < 100;
    const confidence = avgStd > 80 ? 0.7 : avgStd > 60 ? 0.5 : 0.3;

    return { isLikeLogo, confidence };
  } catch (error) {
    return { isLikeLogo: false, confidence: 0 };
  }
}

/**
 * Extract features from center 50% of image (where product typically is)
 */
async function extractCenterRegionFeatures(imageBuffer) {
  try {
    const metadata = await sharp(imageBuffer).metadata();
    const centerWidth = Math.round(metadata.width * 0.5);
    const centerHeight = Math.round(metadata.height * 0.5);
    const left = Math.round((metadata.width - centerWidth) / 2);
    const top = Math.round((metadata.height - centerHeight) / 2);

    if (centerWidth < 10 || centerHeight < 10) return null;

    const centerBuffer = await sharp(imageBuffer)
      .extract({ left, top, width: centerWidth, height: centerHeight })
      .toBuffer();

    const [stats, histogram] = await Promise.all([
      sharp(centerBuffer).stats(),
      getColorHistogram(centerBuffer)
    ]);

    const dominant = stats.dominant;
    const hsl = rgbToHsl(dominant.r, dominant.g, dominant.b);
    const corkMatch = isCorkColor(dominant);
    const corkMatchHSL = isCorkColorHSL(hsl);

    return {
      dominant: { rgb: dominant, hsl },
      isCorkColored: corkMatch.isCork || corkMatchHSL.isCork,
      corkConfidence: Math.max(corkMatch.confidence, corkMatchHSL.confidence),
      histogram
    };
  } catch (error) {
    return null;
  }
}

/**
 * Detect if image has a white/near-white background
 */
function detectWhiteBackground(features, histogram) {
  if (!features || !histogram) return { isWhiteBg: false, confidence: 0 };

  const dom = features.dominant.rgb;
  const isNearWhite = dom.r > 200 && dom.g > 200 && dom.b > 200;

  // Check if top 2 bins (192-255) of all channels dominate (>70% of pixels)
  const rTop = (histogram.r[6] || 0) + (histogram.r[7] || 0);
  const gTop = (histogram.g[6] || 0) + (histogram.g[7] || 0);
  const bTop = (histogram.b[6] || 0) + (histogram.b[7] || 0);
  const histWhite = rTop > 0.7 && gTop > 0.7 && bTop > 0.7;

  if (isNearWhite && histWhite) return { isWhiteBg: true, confidence: 0.95 };
  if (isNearWhite || histWhite) return { isWhiteBg: true, confidence: 0.7 };
  return { isWhiteBg: false, confidence: 0 };
}

/**
 * Check if histogram has significant cork-color bins
 * Cork bins: r=[4-6], g=[3-5], b=[2-4] (bins 0-7, each covering 32 values)
 */
function histogramHasCorkBins(histogram) {
  if (!histogram) return false;

  const rCork = (histogram.r[4] || 0) + (histogram.r[5] || 0) + (histogram.r[6] || 0);
  const gCork = (histogram.g[3] || 0) + (histogram.g[4] || 0) + (histogram.g[5] || 0);
  const bCork = (histogram.b[2] || 0) + (histogram.b[3] || 0) + (histogram.b[4] || 0);

  const avgCork = (rCork + gCork + bCork) / 3;
  return avgCork > 0.15;
}

/**
 * Match image features to product category (background-aware)
 */
function matchToCategory(features, centerFeatures = null, isWhiteBg = false) {
  if (!features) return { category: 'unknown', confidence: 0, scores: {} };

  const scores = {};

  // Score based on aspect ratio and shape
  for (const [product, shape] of Object.entries(PRODUCT_SHAPES)) {
    if (features.aspectRatio >= shape.aspectRatio[0] && features.aspectRatio <= shape.aspectRatio[1]) {
      scores[product] = (scores[product] || 0) + shape.boost;
    }
  }

  // Boost square images for coasters/clocks
  if (features.shape === 'square') {
    scores.coaster = (scores.coaster || 0) + 0.3;
    scores.clock = (scores.clock || 0) + 0.2;
  }

  // Boost portrait for diaries/frames
  if (features.shape === 'portrait') {
    scores.diary = (scores.diary || 0) + 0.3;
    scores.frame = (scores.frame || 0) + 0.2;
  }

  // Background-aware scoring
  if (isWhiteBg) {
    // White background: use center color for cork detection, disable logo boost
    if (centerFeatures && centerFeatures.isCorkColored) {
      for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
        scores[cat] = (scores[cat] || 0) + 0.3;
      }
    }
  } else {
    // Normal: boost all cork categories if cork-colored
    if (features.isCorkColored?.isCork) {
      for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
        scores[cat] = (scores[cat] || 0) + 0.3;
      }
    }
    // Simple images might be logos (only when NOT white background)
    if (features.isSimple) {
      scores.logo = (scores.logo || 0) + 0.5;
    }
  }

  // Center has cork color but full image doesn't -> product on non-cork background
  if (centerFeatures && centerFeatures.isCorkColored && !features.isCorkColored?.isCork) {
    for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
      scores[cat] = (scores[cat] || 0) + 0.3;
    }
  }

  // Histogram cork bins detection
  if (features.histogram && histogramHasCorkBins(features.histogram)) {
    for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
      scores[cat] = (scores[cat] || 0) + 0.2;
    }
  }

  // Find best match
  let bestCategory = 'unknown';
  let bestScore = 0;
  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return {
    category: bestCategory,
    confidence: Math.min(bestScore, 1),
    scores
  };
}

/**
 * Get display name for category
 */
function getCategoryDisplayName(category) {
  const names = {
    coaster: 'coaster',
    diary: 'diary/notebook',
    organizer: 'desk organizer',
    cardholder: 'card holder',
    planter: 'planter',
    bag: 'bag',
    wallet: 'wallet',
    frame: 'photo frame',
    clock: 'clock',
    mousepad: 'mouse pad',
    yogamat: 'yoga mat',
    unknown: 'product'
  };
  return names[category] || 'product';
}

/**
 * Compress image if too large
 */
async function compressImage(imageBuffer, maxSizeMB = 3) {
  const originalSize = imageBuffer.length;
  if (originalSize <= maxSizeMB * 1024 * 1024) {
    return { buffer: imageBuffer, compressed: false };
  }

  try {
    const compressed = await sharp(imageBuffer)
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    console.log(`✅ Compressed: ${(originalSize / 1024 / 1024).toFixed(2)}MB → ${(compressed.length / 1024 / 1024).toFixed(2)}MB`);
    return { buffer: compressed, compressed: true };
  } catch (error) {
    console.error('❌ Compression failed:', error.message);
    return { buffer: imageBuffer, compressed: false };
  }
}

module.exports = {
  CORK_COLORS,
  CATEGORY_KEYWORDS,
  PRODUCT_SHAPES,
  calculatePHash,
  hammingDistance,
  extractImageFeatures,
  getColorHistogram,
  detectEdges,
  isCorkColor,
  isCorkColorHSL,
  rgbToHsl,
  detectLogo,
  matchToCategory,
  getCategoryDisplayName,
  compressImage,
  extractCenterRegionFeatures,
  detectWhiteBackground,
  histogramHasCorkBins
};
