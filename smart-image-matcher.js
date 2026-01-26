// Smart Image Matcher - 3-Layer Image Identification System
// v53.42: Hash Matching → CLIP Similarity → 8+ Vision APIs
// Tier 1: Clarifai (5k/mo), Imagga (1k/mo), DeepAI (free)
// Tier 2: SambaNova, Cloudflare, Fireworks, OpenRouter, Hyperbolic (all free)

const axios = require('axios');
const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class SmartImageMatcher {
  constructor(config = {}) {
    // Multiple Vision API providers (all have free tiers)
    // Tier 1: Dedicated Vision APIs
    this.clarifaiApiKey = config.CLARIFAI_API_KEY;        // 5k free/month
    this.imaggaApiKey = config.IMAGGA_API_KEY;            // 1k free/month
    this.imaggaApiSecret = config.IMAGGA_API_SECRET;
    this.deepaiApiKey = config.DEEPAI_API_KEY;            // Free tier

    // Tier 2: LLM Vision APIs
    this.cloudflareAccountId = config.CLOUDFLARE_ACCOUNT_ID;
    this.cloudflareApiToken = config.CLOUDFLARE_API_TOKEN;
    this.fireworksApiKey = config.FIREWORKS_API_KEY;      // Free tier
    this.openrouterApiKey = config.OPENROUTER_API_KEY;    // Routes to cheapest
    this.sambanovaApiKey = config.SAMBANOVA_API_KEY;      // Free tier, fast
    this.hyperbolicApiKey = config.HYPERBOLIC_API_KEY;    // Free tier

    // Product index storage
    this.indexPath = config.indexPath || './product-image-index.json';
    this.productIndex = {
      hashes: {},      // pHash -> productId mapping
      products: {},    // productId -> product info
      embeddings: {},  // productId -> text embedding (for CLIP-like matching)
      lastUpdated: null
    };

    // CLIP-like text embeddings for product categories (pre-computed)
    this.categoryKeywords = {
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

    // Color signatures for cork products
    this.corkColorRanges = {
      natural: { r: [150, 200], g: [120, 160], b: [70, 120] },
      dark: { r: [100, 150], g: [70, 120], b: [40, 90] },
      light: { r: [180, 230], g: [150, 200], b: [100, 150] }
    };

    this.indexLoaded = false;
    console.log('🎯 Smart Image Matcher initialized');
  }

  // ==================== LAYER 1: HASH MATCHING ====================

  // Calculate perceptual hash (pHash) - 64-bit
  async calculatePHash(imageBuffer) {
    try {
      // Resize to 32x32 grayscale
      const resized = await sharp(imageBuffer)
        .resize(32, 32, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer();

      const pixels = Array.from(resized);

      // Calculate DCT-based hash (simplified)
      // Use 8x8 grid from the 32x32 image
      const gridSize = 8;
      const blockSize = 4; // 32/8 = 4
      const dctValues = [];

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

      // Calculate average (excluding first value which is DC component)
      const avg = dctValues.slice(1).reduce((a, b) => a + b, 0) / (dctValues.length - 1);

      // Generate hash
      let hash = '';
      for (let i = 0; i < 64; i++) {
        hash += dctValues[i] > avg ? '1' : '0';
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

  // Find matching products by hash
  async findByHash(imageBuffer, threshold = 10) {
    const inputHash = await this.calculatePHash(imageBuffer);
    if (!inputHash) return null;

    const matches = [];

    for (const [storedHash, productId] of Object.entries(this.productIndex.hashes)) {
      const distance = this.hammingDistance(inputHash, storedHash);
      if (distance <= threshold) {
        matches.push({
          productId,
          distance,
          confidence: 1 - (distance / 64),
          product: this.productIndex.products[productId]
        });
      }
    }

    // Sort by distance (closest first)
    matches.sort((a, b) => a.distance - b.distance);

    if (matches.length > 0) {
      console.log(`🔍 Hash match found: ${matches[0].product?.name} (distance: ${matches[0].distance})`);
    }

    return matches.length > 0 ? matches[0] : null;
  }

  // ==================== LAYER 2: CLIP-LIKE MATCHING ====================

  // Extract visual features for CLIP-like matching
  async extractVisualFeatures(imageBuffer) {
    try {
      const [metadata, stats, histogram] = await Promise.all([
        sharp(imageBuffer).metadata(),
        sharp(imageBuffer).stats(),
        this.getColorHistogram(imageBuffer)
      ]);

      // Aspect ratio
      const aspectRatio = metadata.width / metadata.height;

      // Dominant color
      const dominant = stats.dominant;

      // Check if cork-colored
      const isCorkColored = this.isCorkColor(dominant);

      // Shape classification based on aspect ratio
      let shape = 'unknown';
      if (aspectRatio >= 0.9 && aspectRatio <= 1.1) shape = 'square';
      else if (aspectRatio < 0.9) shape = 'portrait';
      else shape = 'landscape';

      // Edge detection for complexity
      const edges = await this.detectEdges(imageBuffer);

      return {
        aspectRatio,
        shape,
        dominant,
        isCorkColored,
        histogram,
        edgeComplexity: edges.complexity,
        isSimple: edges.complexity < 0.3 // Simple shapes like logos
      };
    } catch (error) {
      console.error('❌ Feature extraction failed:', error.message);
      return null;
    }
  }

  // Get color histogram
  async getColorHistogram(imageBuffer) {
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

  // Simple edge detection for complexity estimation
  async detectEdges(imageBuffer) {
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
      const complexity = edgePixels / pixels.length;

      return { complexity, edgeCount: edgePixels };
    } catch (error) {
      return { complexity: 0.5, edgeCount: 0 };
    }
  }

  // Check if color is cork-like
  isCorkColor(rgb) {
    for (const [type, range] of Object.entries(this.corkColorRanges)) {
      if (rgb.r >= range.r[0] && rgb.r <= range.r[1] &&
          rgb.g >= range.g[0] && rgb.g <= range.g[1] &&
          rgb.b >= range.b[0] && rgb.b <= range.b[1]) {
        return { isCork: true, type };
      }
    }
    return { isCork: false, type: null };
  }

  // Match visual features to product category (CLIP-like)
  matchToCategory(features) {
    if (!features) return { category: 'unknown', confidence: 0 };

    const scores = {};

    // Score based on aspect ratio
    if (features.shape === 'square') {
      scores.coaster = (scores.coaster || 0) + 0.4;
      scores.clock = (scores.clock || 0) + 0.2;
    } else if (features.shape === 'portrait') {
      scores.diary = (scores.diary || 0) + 0.4;
      scores.frame = (scores.frame || 0) + 0.3;
    } else if (features.shape === 'landscape') {
      scores.wallet = (scores.wallet || 0) + 0.3;
      scores.mousepad = (scores.mousepad || 0) + 0.3;
      scores.bag = (scores.bag || 0) + 0.2;
    }

    // Score based on cork color
    if (features.isCorkColored.isCork) {
      // Boost all cork product categories
      for (const cat of Object.keys(this.categoryKeywords)) {
        scores[cat] = (scores[cat] || 0) + 0.3;
      }
    }

    // Score based on complexity
    if (features.isSimple) {
      // Simple images might be logos
      scores.logo = (scores.logo || 0) + 0.5;
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

  // ==================== LAYER 3: MULTIPLE VISION APIs ====================

  // ---- TIER 1: Dedicated Image Recognition APIs ----

  // Clarifai (FREE 5k/month) - Best for product recognition
  async analyzeWithClarifai(imageBuffer, prompt) {
    if (!this.clarifaiApiKey) {
      throw new Error('Clarifai API key not configured');
    }

    try {
      console.log('🔮 Trying Clarifai (5k free/month)...');

      const base64Image = imageBuffer.toString('base64');

      // Use general-image-recognition model
      const response = await axios.post(
        'https://api.clarifai.com/v2/models/general-image-recognition/outputs',
        {
          inputs: [{
            data: {
              image: { base64: base64Image }
            }
          }]
        },
        {
          headers: {
            'Authorization': `Key ${this.clarifaiApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const concepts = response.data?.outputs?.[0]?.data?.concepts || [];
      if (concepts.length === 0) throw new Error('No concepts detected');

      // Get top 5 concepts
      const topConcepts = concepts.slice(0, 5).map(c => c.name);
      console.log(`   Detected: ${topConcepts.join(', ')}`);

      // Generate response based on detected concepts
      const corkRelated = ['cork', 'wood', 'brown', 'texture', 'natural', 'coaster', 'notebook', 'diary'];
      const isCorkProduct = topConcepts.some(c => corkRelated.includes(c.toLowerCase()));

      let responseText;
      if (isCorkProduct) {
        responseText = `I can see this appears to be a cork product! The image shows: ${topConcepts.slice(0, 3).join(', ')}. How many pieces would you like?`;
      } else if (topConcepts.some(c => ['logo', 'text', 'design', 'graphic'].includes(c.toLowerCase()))) {
        responseText = `I see a design/logo! I can customize this on cork products. Is this for corporate branding or a personal gift?`;
      } else {
        responseText = `I can see: ${topConcepts.slice(0, 3).join(', ')}. Which cork product are you interested in?`;
      }

      console.log('✅ Clarifai succeeded');
      return { provider: 'clarifai', response: responseText, concepts, success: true };

    } catch (error) {
      console.error('❌ Clarifai failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // Imagga (FREE 1k/month) - Good for tagging
  async analyzeWithImagga(imageBuffer, prompt) {
    if (!this.imaggaApiKey || !this.imaggaApiSecret) {
      throw new Error('Imagga credentials not configured');
    }

    try {
      console.log('🏷️ Trying Imagga (1k free/month)...');

      const base64Image = imageBuffer.toString('base64');

      const response = await axios.post(
        'https://api.imagga.com/v2/tags',
        { image_base64: base64Image },
        {
          auth: {
            username: this.imaggaApiKey,
            password: this.imaggaApiSecret
          },
          timeout: 30000
        }
      );

      const tags = response.data?.result?.tags || [];
      if (tags.length === 0) throw new Error('No tags detected');

      // Get top tags with confidence > 30%
      const topTags = tags
        .filter(t => t.confidence > 30)
        .slice(0, 5)
        .map(t => t.tag.en);

      console.log(`   Tags: ${topTags.join(', ')}`);

      // Generate response
      const corkKeywords = ['cork', 'wood', 'brown', 'coaster', 'notebook', 'leather', 'texture'];
      const isCorkLike = topTags.some(t => corkKeywords.some(k => t.toLowerCase().includes(k)));

      let responseText;
      if (isCorkLike) {
        responseText = `This looks like a cork product! I can see: ${topTags.slice(0, 3).join(', ')}. How many do you need?`;
      } else {
        responseText = `I see: ${topTags.slice(0, 3).join(', ')}. Which cork product would you like this on?`;
      }

      console.log('✅ Imagga succeeded');
      return { provider: 'imagga', response: responseText, tags: topTags, success: true };

    } catch (error) {
      console.error('❌ Imagga failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // DeepAI (FREE tier) - General image analysis
  async analyzeWithDeepAI(imageBuffer, prompt) {
    if (!this.deepaiApiKey) {
      throw new Error('DeepAI API key not configured');
    }

    try {
      console.log('🧠 Trying DeepAI (free tier)...');

      const FormData = require('form-data');
      const form = new FormData();
      form.append('image', imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

      const response = await axios.post(
        'https://api.deepai.org/api/densecap',
        form,
        {
          headers: {
            'api-key': this.deepaiApiKey,
            ...form.getHeaders()
          },
          timeout: 30000
        }
      );

      const captions = response.data?.output?.captions || [];
      if (captions.length === 0) throw new Error('No captions generated');

      const descriptions = captions.slice(0, 3).map(c => c.caption);
      console.log(`   Captions: ${descriptions.join('; ')}`);

      const responseText = `I can see: ${descriptions.join(', ')}. Which cork product interests you?`;

      console.log('✅ DeepAI succeeded');
      return { provider: 'deepai', response: responseText, captions: descriptions, success: true };

    } catch (error) {
      console.error('❌ DeepAI failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // ---- TIER 2: LLM Vision APIs ----

  // SambaNova (FREE tier, very fast)
  async analyzeWithSambaNova(imageBuffer, prompt) {
    if (!this.sambanovaApiKey) {
      throw new Error('SambaNova API key not configured');
    }

    try {
      console.log('⚡ Trying SambaNova (FREE, fast)...');

      const base64Image = imageBuffer.toString('base64');

      const response = await axios.post(
        'https://api.sambanova.ai/v1/chat/completions',
        {
          model: 'Llama-3.2-11B-Vision-Instruct',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }],
          max_tokens: 300,
          temperature: 0.4
        },
        {
          headers: {
            'Authorization': `Bearer ${this.sambanovaApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      if (!aiResponse) throw new Error('Empty response');

      console.log('✅ SambaNova succeeded');
      return { provider: 'sambanova-llama-vision', response: aiResponse, success: true };

    } catch (error) {
      console.error('❌ SambaNova failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // Cloudflare Workers AI (FREE 10k/day)
  async analyzeWithCloudflare(imageBuffer, prompt) {
    if (!this.cloudflareAccountId || !this.cloudflareApiToken) {
      throw new Error('Cloudflare credentials not configured');
    }

    try {
      console.log('☁️ Trying Cloudflare Workers AI (FREE)...');

      const base64Image = imageBuffer.toString('base64');

      const response = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${this.cloudflareAccountId}/ai/run/@cf/llava-hf/llava-1.5-7b-hf`,
        {
          image: base64Image,
          prompt: prompt,
          max_tokens: 256
        },
        {
          headers: {
            'Authorization': `Bearer ${this.cloudflareApiToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data?.success && response.data?.result?.description) {
        console.log('✅ Cloudflare AI succeeded');
        return {
          provider: 'cloudflare-llava',
          response: response.data.result.description,
          success: true
        };
      }

      throw new Error('Empty response from Cloudflare');

    } catch (error) {
      console.error('❌ Cloudflare AI failed:', error.response?.data?.errors || error.message);
      throw error;
    }
  }

  // Fireworks AI (FREE tier available)
  async analyzeWithFireworks(imageBuffer, prompt) {
    if (!this.fireworksApiKey) {
      throw new Error('Fireworks API key not configured');
    }

    try {
      console.log('🔥 Trying Fireworks AI...');

      const base64Image = imageBuffer.toString('base64');

      const response = await axios.post(
        'https://api.fireworks.ai/inference/v1/chat/completions',
        {
          model: 'accounts/fireworks/models/llama-v3p2-11b-vision-instruct',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }],
          max_tokens: 300,
          temperature: 0.4
        },
        {
          headers: {
            'Authorization': `Bearer ${this.fireworksApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      if (aiResponse) {
        console.log('✅ Fireworks AI succeeded');
        return { provider: 'fireworks-llama-vision', response: aiResponse, success: true };
      }

      throw new Error('Empty response');

    } catch (error) {
      console.error('❌ Fireworks AI failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // OpenRouter (routes to cheapest/free models)
  async analyzeWithOpenRouter(imageBuffer, prompt) {
    if (!this.openrouterApiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    try {
      console.log('🔀 Trying OpenRouter (auto-routes to best model)...');

      const base64Image = imageBuffer.toString('base64');

      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'meta-llama/llama-3.2-11b-vision-instruct:free', // Free model
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }],
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${this.openrouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://9cork.com',
            'X-Title': '9Cork Vision'
          },
          timeout: 30000
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      if (aiResponse) {
        console.log('✅ OpenRouter succeeded');
        return { provider: 'openrouter-llama-vision', response: aiResponse, success: true };
      }

      throw new Error('Empty response');

    } catch (error) {
      console.error('❌ OpenRouter failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // Hyperbolic (FREE tier)
  async analyzeWithHyperbolic(imageBuffer, prompt) {
    if (!this.hyperbolicApiKey) {
      throw new Error('Hyperbolic API key not configured');
    }

    try {
      console.log('⚡ Trying Hyperbolic AI (FREE)...');

      const base64Image = imageBuffer.toString('base64');

      const response = await axios.post(
        'https://api.hyperbolic.xyz/v1/chat/completions',
        {
          model: 'Qwen/Qwen2-VL-7B-Instruct',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }],
          max_tokens: 300,
          temperature: 0.4
        },
        {
          headers: {
            'Authorization': `Bearer ${this.hyperbolicApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      if (aiResponse) {
        console.log('✅ Hyperbolic AI succeeded');
        return { provider: 'hyperbolic-qwen-vision', response: aiResponse, success: true };
      }

      throw new Error('Empty response');

    } catch (error) {
      console.error('❌ Hyperbolic AI failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // Try all Layer 3 providers in sequence (ordered by reliability/speed)
  async tryAllVisionAPIs(imageBuffer, prompt) {
    const providers = [
      // Tier 1: Dedicated Vision APIs (most reliable for product recognition)
      { name: 'Clarifai', fn: () => this.analyzeWithClarifai(imageBuffer, prompt), configured: !!this.clarifaiApiKey },
      { name: 'Imagga', fn: () => this.analyzeWithImagga(imageBuffer, prompt), configured: !!(this.imaggaApiKey && this.imaggaApiSecret) },
      { name: 'DeepAI', fn: () => this.analyzeWithDeepAI(imageBuffer, prompt), configured: !!this.deepaiApiKey },

      // Tier 2: LLM Vision APIs (better understanding, may have rate limits)
      { name: 'SambaNova', fn: () => this.analyzeWithSambaNova(imageBuffer, prompt), configured: !!this.sambanovaApiKey },
      { name: 'Cloudflare', fn: () => this.analyzeWithCloudflare(imageBuffer, prompt), configured: !!(this.cloudflareAccountId && this.cloudflareApiToken) },
      { name: 'Fireworks', fn: () => this.analyzeWithFireworks(imageBuffer, prompt), configured: !!this.fireworksApiKey },
      { name: 'OpenRouter', fn: () => this.analyzeWithOpenRouter(imageBuffer, prompt), configured: !!this.openrouterApiKey },
      { name: 'Hyperbolic', fn: () => this.analyzeWithHyperbolic(imageBuffer, prompt), configured: !!this.hyperbolicApiKey }
    ];

    const configuredCount = providers.filter(p => p.configured).length;
    console.log(`   ${configuredCount} vision APIs configured`);

    for (const provider of providers) {
      if (!provider.configured) continue;

      try {
        const result = await provider.fn();
        if (result.success) return result;
      } catch (error) {
        console.log(`   ${provider.name} failed, trying next...`);
      }
    }

    throw new Error('All vision APIs failed');
  }

  // ==================== COMBINED MATCHING ====================

  async identifyImage(imageBuffer, userMessage = '') {
    console.log('🎯 Starting 3-layer image identification...');

    const results = {
      layer1_hash: null,
      layer2_clip: null,
      layer3_cloudflare: null,
      finalResult: null
    };

    // Load index if not loaded
    await this.loadIndex();

    // LAYER 1: Hash Matching (instant)
    console.log('📍 Layer 1: Hash matching...');
    try {
      const hashMatch = await this.findByHash(imageBuffer);
      if (hashMatch && hashMatch.confidence > 0.8) {
        results.layer1_hash = hashMatch;
        results.finalResult = {
          method: 'hash_match',
          product: hashMatch.product,
          confidence: hashMatch.confidence,
          message: `This looks like our ${hashMatch.product?.name}! How many would you like?`
        };
        console.log(`✅ Layer 1 match: ${hashMatch.product?.name} (${(hashMatch.confidence * 100).toFixed(0)}%)`);
        return results;
      }
    } catch (error) {
      console.log('   Layer 1 skipped:', error.message);
    }

    // LAYER 2: Visual Feature Matching (CLIP-like)
    console.log('📍 Layer 2: Visual feature analysis...');
    try {
      const features = await this.extractVisualFeatures(imageBuffer);
      const categoryMatch = this.matchToCategory(features);

      results.layer2_clip = {
        features,
        category: categoryMatch
      };

      if (categoryMatch.confidence > 0.6) {
        // High confidence category match
        if (categoryMatch.category === 'logo') {
          results.finalResult = {
            method: 'visual_analysis',
            category: 'logo',
            confidence: categoryMatch.confidence,
            message: "I see you've shared a logo/design! I can customize this on cork. Is this for corporate branding or a personal gift?"
          };
        } else {
          results.finalResult = {
            method: 'visual_analysis',
            category: categoryMatch.category,
            confidence: categoryMatch.confidence,
            message: `This looks like a cork ${categoryMatch.category}! How many pieces do you need, and is this for personal use or corporate gifting?`
          };
        }
        console.log(`✅ Layer 2 match: ${categoryMatch.category} (${(categoryMatch.confidence * 100).toFixed(0)}%)`);
        return results;
      }
    } catch (error) {
      console.log('   Layer 2 error:', error.message);
    }

    // LAYER 3: Vision APIs (Cloudflare, Fireworks, OpenRouter, Hyperbolic)
    console.log('📍 Layer 3: Vision API analysis...');
    const hasAnyVisionAPI = (this.cloudflareAccountId && this.cloudflareApiToken) ||
                            this.fireworksApiKey ||
                            this.openrouterApiKey ||
                            this.hyperbolicApiKey;

    if (hasAnyVisionAPI) {
      try {
        const prompt = `You are Priya, a sales expert for 9Cork (sustainable cork products).
Analyze this image. Products include: coasters, diaries, desk organizers, card holders, planters, bags, wallets, frames, clocks.
If it's a cork product, identify it specifically and ask about quantity.
If it's a logo/design, say you can customize it on cork products.
Respond in 1-2 short sentences.`;

        const apiResult = await this.tryAllVisionAPIs(imageBuffer, prompt);
        results.layer3_cloudflare = apiResult;
        results.finalResult = {
          method: apiResult.provider,
          confidence: 0.85,
          message: apiResult.response
        };
        return results;

      } catch (error) {
        console.log('   Layer 3 failed:', error.message);
      }
    } else {
      console.log('   Layer 3 skipped: No vision APIs configured');
      console.log('   💡 Get FREE keys from:');
      console.log('      - Cloudflare: https://dash.cloudflare.com (Workers AI)');
      console.log('      - Fireworks: https://fireworks.ai');
      console.log('      - OpenRouter: https://openrouter.ai');
      console.log('      - Hyperbolic: https://hyperbolic.xyz');
    }

    // FALLBACK: Use Layer 2 result even with low confidence
    if (results.layer2_clip?.category?.category !== 'unknown') {
      const cat = results.layer2_clip.category;
      results.finalResult = {
        method: 'visual_analysis_fallback',
        category: cat.category,
        confidence: cat.confidence,
        message: cat.category === 'logo'
          ? "Thanks for sharing this image! Which cork product would you like this design on - coasters, diaries, or something else?"
          : `I can see this might be related to ${cat.category}. Could you tell me more about what you're looking for?`
      };
    } else {
      // Ultimate fallback
      results.finalResult = {
        method: 'fallback',
        confidence: 0,
        message: "Thanks for the image! Could you tell me which cork product you're interested in - coasters, diaries, bags, or something else?"
      };
    }

    return results;
  }

  // ==================== INDEX MANAGEMENT ====================

  async loadIndex() {
    if (this.indexLoaded) return;

    try {
      const data = await fs.readFile(this.indexPath, 'utf8');
      this.productIndex = JSON.parse(data);
      this.indexLoaded = true;
      console.log(`📦 Loaded product index: ${Object.keys(this.productIndex.products).length} products`);
    } catch (error) {
      console.log('📦 No existing index found, starting fresh');
      this.indexLoaded = true;
    }
  }

  async saveIndex() {
    this.productIndex.lastUpdated = new Date().toISOString();
    await fs.writeFile(this.indexPath, JSON.stringify(this.productIndex, null, 2));
    console.log('💾 Product index saved');
  }

  // Index a single product image
  async indexProductImage(productId, productInfo, imageBuffer) {
    try {
      const hash = await this.calculatePHash(imageBuffer);
      if (hash) {
        this.productIndex.hashes[hash] = productId;
        this.productIndex.products[productId] = productInfo;
        return true;
      }
    } catch (error) {
      console.error(`Failed to index ${productId}:`, error.message);
    }
    return false;
  }

  // Build index from product database
  async buildIndexFromDatabase(Product, downloadImage) {
    console.log('🔨 Building product image index...');

    const products = await Product.find({ images: { $exists: true, $ne: [] } });
    let indexed = 0;

    for (const product of products) {
      if (product.images && product.images[0]) {
        try {
          // Download image
          const imageBuffer = await downloadImage(product.images[0]);
          if (imageBuffer) {
            await this.indexProductImage(product.productId, {
              name: product.name,
              category: product.category,
              price: product.price,
              image: product.images[0]
            }, imageBuffer);
            indexed++;
          }
        } catch (error) {
          console.log(`   Skip ${product.name}: ${error.message}`);
        }
      }
    }

    await this.saveIndex();
    console.log(`✅ Indexed ${indexed}/${products.length} products`);
  }

  // Get stats
  getStats() {
    return {
      productsIndexed: Object.keys(this.productIndex.products).length,
      hashesStored: Object.keys(this.productIndex.hashes).length,
      lastUpdated: this.productIndex.lastUpdated,
      cloudflareConfigured: !!(this.cloudflareAccountId && this.cloudflareApiToken)
    };
  }
}

module.exports = SmartImageMatcher;
