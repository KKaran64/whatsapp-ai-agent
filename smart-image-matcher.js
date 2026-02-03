// Smart Image Matcher v3 - 4-Layer Image Identification with Local ML
// v54.3: Added Layer 0 for local ML inference (TensorFlow.js, ONNX, Transformers.js)

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const {
  calculatePHash,
  hammingDistance,
  extractImageFeatures,
  matchToCategory,
  detectLogo,
  getCategoryDisplayName,
  extractCenterRegionFeatures,
  detectWhiteBackground,
  histogramHasCorkBins
} = require('./vision-utils');

// ==================== LAYER 0: LOCAL ML CONFIGURATION ====================

// Cork product categories for local classification
const CORK_PRODUCT_LABELS = {
  // MobileNet/ImageNet class mappings to cork products
  'notebook': 'diary',
  'book_jacket': 'diary',
  'binder': 'diary',
  'envelope': 'diary',
  'wallet': 'wallet',
  'billfold': 'wallet',
  'purse': 'bag',
  'handbag': 'bag',
  'backpack': 'bag',
  'tote': 'bag',
  'shopping_bag': 'bag',
  'bag': 'bag',
  'travel_bag': 'bag',
  'laptop_bag': 'bag',
  'cup': 'coaster',
  'coffee_mug': 'coaster',
  'beer_glass': 'coaster',
  'goblet': 'coaster',
  'wine_glass': 'coaster',
  'coaster': 'coaster',
  'mat': 'coaster',
  'mouse': 'mousepad',
  'computer_mouse': 'mousepad',
  'desk': 'organizer',
  'pencil_box': 'organizer',
  'pencil_sharpener': 'organizer',
  'pot': 'planter',
  'flowerpot': 'planter',
  'vase': 'planter',
  'planter': 'planter',
  'picture_frame': 'frame',
  'frame': 'frame',
  'wall_clock': 'clock',
  'analog_clock': 'clock',
  'digital_clock': 'clock',
  'clock': 'clock',
  'yoga_mat': 'yogamat',
  'exercise_mat': 'yogamat',
  'card': 'cardholder',
  'credit_card': 'cardholder',
  'id_card': 'cardholder',
  // Round/flat cork items -> coaster
  'face_powder': 'coaster',
  'dough': 'coaster',
  'doormat': 'coaster',
  'band_aid': 'coaster',
  'wool': 'coaster',
  'jigsaw_puzzle': 'coaster',
  'sundial': 'coaster',
  'matchstick': 'coaster',
  'tray': 'coaster',
  'plate_rack': 'coaster',
  // Tea light holders, cylindrical items -> planter
  'candle': 'planter',
  'taper': 'planter',
  'wax_light': 'planter',
  'bottlecap': 'planter',
  'pedestal': 'planter',
  'plinth': 'planter',
  // Vessel-shaped items -> planter
  'mortar': 'planter',
  'soap_dispenser': 'planter',
  'pottery': 'planter',
  // Box-like desk items -> organizer
  'carton': 'organizer',
  'cardboard': 'organizer',
  'crate': 'organizer',
  'rubber_eraser': 'organizer',
  'screw': 'organizer',
  'ballpoint': 'organizer',
  'pen': 'organizer',
  'wine_bottle': 'organizer',
  'cleaver': 'organizer',
  // Bag-shaped items -> bag
  'mailbag': 'bag',
  'postbag': 'bag',
  'packet': 'bag',
  'hamper': 'bag',
  // Mat/rug shaped items -> yogamat
  'prayer_rug': 'yogamat',
  'welcome_mat': 'yogamat',
  // Rectangular framed items -> frame
  'scale': 'frame',
  'rule': 'frame',
  'ruler': 'frame'
};

// Keywords that indicate cork material
const CORK_MATERIAL_KEYWORDS = ['cork', 'wood', 'wooden', 'brown', 'tan', 'natural', 'texture', 'grain', 'organic'];

// Local ML provider configurations
const LOCAL_ML_PROVIDERS = {
  tensorflow: {
    name: 'TensorFlow.js',
    priority: 1,
    modelName: 'mobilenet',
    checkAvailable: () => {
      try {
        require('@tensorflow/tfjs-node');
        require('@tensorflow-models/mobilenet');
        return true;
      } catch { return false; }
    },
    loadModel: async () => {
      const tf = require('@tensorflow/tfjs-node');
      const mobilenet = require('@tensorflow-models/mobilenet');
      return await mobilenet.load({ version: 2, alpha: 1.0 });
    },
    classify: async (model, imageBuffer) => {
      const tf = require('@tensorflow/tfjs-node');
      const imageTensor = tf.node.decodeImage(imageBuffer, 3);
      const predictions = await model.classify(imageTensor);
      imageTensor.dispose();
      return predictions.map(p => ({ label: p.className.toLowerCase(), score: p.probability }));
    }
  },

  onnx: {
    name: 'ONNX Runtime',
    priority: 2,
    modelPath: './models/mobilenet.onnx',
    checkAvailable: () => {
      try {
        require('onnxruntime-node');
        return true;
      } catch { return false; }
    },
    loadModel: async function() {
      const ort = require('onnxruntime-node');
      const modelPath = path.resolve(this.modelPath);
      try {
        await fs.access(modelPath);
        return await ort.InferenceSession.create(modelPath);
      } catch {
        console.log('   ONNX model not found at', modelPath);
        return null;
      }
    },
    classify: async (session, imageBuffer) => {
      // Requires preprocessing - simplified for now
      return null; // Needs custom implementation per model
    }
  },

  transformers: {
    name: 'Transformers.js',
    priority: 3,
    modelName: 'Xenova/vit-base-patch16-224',
    checkAvailable: () => {
      try {
        require('@xenova/transformers');
        return true;
      } catch { return false; }
    },
    loadModel: async function() {
      const { pipeline } = require('@xenova/transformers');
      return await pipeline('image-classification', this.modelName);
    },
    classify: async (classifier, imageBuffer) => {
      const result = await classifier(imageBuffer);
      return result.map(r => ({ label: r.label.toLowerCase(), score: r.score }));
    }
  },

  ollama: {
    name: 'Ollama Vision (LLaVA)',
    priority: 4,
    modelName: 'llava:7b',
    baseUrl: 'http://localhost:11434',
    isAsync: true, // Flag for async checkAvailable
    checkAvailable: function() {
      // Sync check just verifies axios is available - actual check is in loadModel
      return true; // Will fail gracefully in loadModel if Ollama not running
    },
    loadModel: async function() {
      // Ollama doesn't need model loading - just verify it's running
      try {
        const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 2000 });
        const models = response.data?.models || [];
        const visionModel = models.find(m => m.name.includes('llava') || m.name.includes('llama3.2'));
        if (visionModel) {
          this.modelName = visionModel.name;
          return { ready: true, model: visionModel.name };
        }
        return null;
      } catch { return null; }
    },
    classify: async function(_, imageBuffer) {
      const prompt = `Classify this image into ONE of these cork product categories:
coaster, diary, wallet, bag, organizer, planter, frame, clock, mousepad, cardholder, yogamat, logo

Reply with ONLY the category name and confidence (0-100), like: "coaster 85"
If it's a logo/design image, reply: "logo 90"`;

      try {
        const response = await axios.post(`${this.baseUrl}/api/generate`, {
          model: this.modelName,
          prompt,
          images: [imageBuffer.toString('base64')],
          stream: false
        }, { timeout: 30000 });

        const text = response.data?.response?.trim().toLowerCase() || '';
        const match = text.match(/(\w+)\s*(\d+)?/);

        if (match) {
          const label = match[1];
          const score = match[2] ? parseInt(match[2]) / 100 : 0.7;
          return [{ label, score }];
        }
        return [{ label: text, score: 0.5 }];
      } catch (error) {
        throw new Error(`Ollama failed: ${error.message}`);
      }
    }
  }
};

// Generic Vision API Provider configuration
const VISION_PROVIDERS = {
  // Tier 1: Dedicated Vision APIs
  clarifai: {
    name: 'Clarifai',
    tier: 1,
    configKeys: ['CLARIFAI_API_KEY'],
    endpoint: 'https://api.clarifai.com/v2/models/general-image-recognition/outputs',
    buildRequest: (base64, prompt, config) => ({
      method: 'POST',
      url: 'https://api.clarifai.com/v2/models/general-image-recognition/outputs',
      headers: { 'Authorization': `Key ${config.CLARIFAI_API_KEY}`, 'Content-Type': 'application/json' },
      data: { inputs: [{ data: { image: { base64 } } }] },
      timeout: 30000
    }),
    parseResponse: (response) => {
      const concepts = response.data?.outputs?.[0]?.data?.concepts || [];
      if (!concepts.length) throw new Error('No concepts detected');
      return concepts.slice(0, 5).map(c => c.name);
    },
    formatResult: (tags) => {
      const corkKeywords = ['cork', 'wood', 'brown', 'texture', 'natural', 'coaster', 'notebook', 'diary'];
      const isCork = tags.some(t => corkKeywords.includes(t.toLowerCase()));
      if (isCork) return `I can see this appears to be a cork product! The image shows: ${tags.slice(0, 3).join(', ')}. How many pieces would you like?`;
      if (tags.some(t => ['logo', 'text', 'design', 'graphic'].includes(t.toLowerCase()))) {
        return `I see a design/logo! I can customize this on cork products. Is this for corporate branding or a personal gift?`;
      }
      return `I can see: ${tags.slice(0, 3).join(', ')}. Which cork product are you interested in?`;
    }
  },

  imagga: {
    name: 'Imagga',
    tier: 1,
    configKeys: ['IMAGGA_API_KEY', 'IMAGGA_API_SECRET'],
    buildRequest: (base64, prompt, config) => ({
      method: 'POST',
      url: 'https://api.imagga.com/v2/tags',
      auth: { username: config.IMAGGA_API_KEY, password: config.IMAGGA_API_SECRET },
      data: { image_base64: base64 },
      timeout: 30000
    }),
    parseResponse: (response) => {
      const tags = response.data?.result?.tags || [];
      if (!tags.length) throw new Error('No tags detected');
      return tags.filter(t => t.confidence > 30).slice(0, 5).map(t => t.tag.en);
    },
    formatResult: (tags) => {
      const corkKeywords = ['cork', 'wood', 'brown', 'coaster', 'notebook', 'leather', 'texture'];
      const isCork = tags.some(t => corkKeywords.some(k => t.toLowerCase().includes(k)));
      if (isCork) return `This looks like a cork product! I can see: ${tags.slice(0, 3).join(', ')}. How many do you need?`;
      return `I see: ${tags.slice(0, 3).join(', ')}. Which cork product would you like this on?`;
    }
  },

  deepai: {
    name: 'DeepAI',
    tier: 1,
    configKeys: ['DEEPAI_API_KEY'],
    buildRequest: (base64, prompt, config) => {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('image', Buffer.from(base64, 'base64'), { filename: 'image.jpg', contentType: 'image/jpeg' });
      return {
        method: 'POST',
        url: 'https://api.deepai.org/api/densecap',
        headers: { 'api-key': config.DEEPAI_API_KEY, ...form.getHeaders() },
        data: form,
        timeout: 30000
      };
    },
    parseResponse: (response) => {
      const captions = response.data?.output?.captions || [];
      if (!captions.length) throw new Error('No captions generated');
      return captions.slice(0, 3).map(c => c.caption);
    },
    formatResult: (captions) => `I can see: ${captions.join(', ')}. Which cork product interests you?`
  },

  // Tier 2: LLM Vision APIs (OpenAI-compatible format)
  sambanova: {
    name: 'SambaNova',
    tier: 2,
    configKeys: ['SAMBANOVA_API_KEY'],
    buildRequest: (base64, prompt, config) => ({
      method: 'POST',
      url: 'https://api.sambanova.ai/v1/chat/completions',
      headers: { 'Authorization': `Bearer ${config.SAMBANOVA_API_KEY}`, 'Content-Type': 'application/json' },
      data: {
        model: 'Llama-3.2-11B-Vision-Instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]}],
        max_tokens: 300,
        temperature: 0.4
      },
      timeout: 30000
    }),
    parseResponse: (response) => {
      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response');
      return content;
    },
    formatResult: (response) => response
  },

  cloudflare: {
    name: 'Cloudflare',
    tier: 2,
    configKeys: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
    buildRequest: (base64, prompt, config) => ({
      method: 'POST',
      url: `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/llava-hf/llava-1.5-7b-hf`,
      headers: { 'Authorization': `Bearer ${config.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      data: { image: base64, prompt, max_tokens: 256 },
      timeout: 30000
    }),
    parseResponse: (response) => {
      if (response.data?.success && response.data?.result?.description) {
        return response.data.result.description;
      }
      throw new Error('Empty response from Cloudflare');
    },
    formatResult: (response) => response
  },

  fireworks: {
    name: 'Fireworks',
    tier: 2,
    configKeys: ['FIREWORKS_API_KEY'],
    buildRequest: (base64, prompt, config) => ({
      method: 'POST',
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      headers: { 'Authorization': `Bearer ${config.FIREWORKS_API_KEY}`, 'Content-Type': 'application/json' },
      data: {
        model: 'accounts/fireworks/models/llama-v3p2-11b-vision-instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]}],
        max_tokens: 300,
        temperature: 0.4
      },
      timeout: 30000
    }),
    parseResponse: (response) => {
      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response');
      return content;
    },
    formatResult: (response) => response
  },

  openrouter: {
    name: 'OpenRouter',
    tier: 2,
    configKeys: ['OPENROUTER_API_KEY'],
    buildRequest: (base64, prompt, config) => ({
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://9cork.com',
        'X-Title': '9Cork Vision'
      },
      data: {
        model: 'meta-llama/llama-3.2-11b-vision-instruct:free',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]}],
        max_tokens: 300
      },
      timeout: 30000
    }),
    parseResponse: (response) => {
      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response');
      return content;
    },
    formatResult: (response) => response
  },

  hyperbolic: {
    name: 'Hyperbolic',
    tier: 2,
    configKeys: ['HYPERBOLIC_API_KEY'],
    buildRequest: (base64, prompt, config) => ({
      method: 'POST',
      url: 'https://api.hyperbolic.xyz/v1/chat/completions',
      headers: { 'Authorization': `Bearer ${config.HYPERBOLIC_API_KEY}`, 'Content-Type': 'application/json' },
      data: {
        model: 'Qwen/Qwen2-VL-7B-Instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]}],
        max_tokens: 300,
        temperature: 0.4
      },
      timeout: 30000
    }),
    parseResponse: (response) => {
      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response');
      return content;
    },
    formatResult: (response) => response
  }
};

class SmartImageMatcher {
  constructor(config) {
    this.config = config || {};
    this.indexPath = this.config.indexPath || './product-image-index.json';
    this.productIndex = { hashes: {}, products: {}, lastUpdated: null };
    this.indexLoaded = false;

    // Determine which providers are configured
    this.configuredProviders = this._getConfiguredProviders();

    // Layer 0: Local ML setup
    this.localMLProvider = null;
    this.localMLModel = null;
    this.localMLReady = false;
    this.localMLInitPromise = this._initLocalML(); // Store promise for await

    // Layer 1: Hash index (background build)
    this.hashIndexPromise = this.buildProductHashIndex();

    // Stats tracking
    this.stats = { byProvider: {}, localML: { success: 0, failures: 0 }, totalSuccess: 0, totalFailures: 0 };
    for (const id of Object.keys(VISION_PROVIDERS)) {
      this.stats.byProvider[id] = { success: 0, failures: 0 };
    }

    console.log(`🎯 Smart Image Matcher v3 initialized (4-layer architecture)`);
    console.log(`   Layer 0 (Local ML): ${this.localMLProvider?.name || 'Not available'}`);
    console.log(`   Layer 3 (APIs): ${this.configuredProviders.map(p => p.name).join(', ') || 'None'}`);
  }

  async _initLocalML() {
    // Try to initialize local ML in order of priority
    const providers = Object.entries(LOCAL_ML_PROVIDERS)
      .sort((a, b) => a[1].priority - b[1].priority);

    for (const [id, provider] of providers) {
      try {
        if (provider.checkAvailable()) {
          console.log(`   🔄 Loading ${provider.name}...`);
          const model = await provider.loadModel();
          if (model) {
            this.localMLProvider = { id, ...provider };
            this.localMLModel = model;
            this.localMLReady = true;
            console.log(`   ✅ ${provider.name} loaded successfully`);
            return;
          }
        }
      } catch (error) {
        console.log(`   ⚠️ ${provider.name} failed:`, error.message);
      }
    }
    console.log('   ℹ️ No local ML available - using cloud APIs only');
  }

  _getConfiguredProviders() {
    const configured = [];
    for (const [id, provider] of Object.entries(VISION_PROVIDERS)) {
      const hasAllKeys = provider.configKeys.every(key => !!this.config[key]);
      if (hasAllKeys) {
        configured.push({ id, ...provider });
      }
    }
    // Sort by tier (lower tier = higher priority)
    return configured.sort((a, b) => a.tier - b.tier);
  }

  // ==================== LAYER 0: LOCAL ML INFERENCE ====================

  async classifyWithLocalML(imageBuffer) {
    if (!this.localMLReady || !this.localMLModel) {
      return null;
    }

    try {
      console.log(`   Using ${this.localMLProvider.name}...`);
      const predictions = await this.localMLProvider.classify(this.localMLModel, imageBuffer);

      if (!predictions || predictions.length === 0) {
        return null;
      }

      // Map predictions to cork products using substring matching
      const mappedResults = [];
      for (const pred of predictions) {
        const corkProduct = this._mapPredictionToCorkProduct(pred.label);
        if (corkProduct) {
          mappedResults.push({
            originalLabel: pred.label,
            corkCategory: corkProduct,
            confidence: pred.score,
            source: 'label_mapping'
          });
        }

        // Check for cork material keywords
        const hasCorkKeyword = CORK_MATERIAL_KEYWORDS.some(kw =>
          pred.label.toLowerCase().includes(kw)
        );
        if (hasCorkKeyword && pred.score > 0.3) {
          mappedResults.push({
            originalLabel: pred.label,
            corkCategory: 'cork_material',
            confidence: pred.score * 1.2,
            source: 'material_keyword'
          });
        }
      }

      // Multi-prediction consensus: if top-3 map to same category, boost by +0.2
      const top3Mapped = predictions.slice(0, 3)
        .map(p => this._mapPredictionToCorkProduct(p.label))
        .filter(Boolean);
      if (top3Mapped.length >= 2 && top3Mapped.every(c => c === top3Mapped[0])) {
        for (const result of mappedResults) {
          if (result.corkCategory === top3Mapped[0]) {
            result.confidence = Math.min(result.confidence + 0.2, 1.0);
            result.source = 'consensus_boost';
          }
        }
      }

      // Sort by confidence and return best match
      mappedResults.sort((a, b) => b.confidence - a.confidence);

      if (mappedResults.length > 0) {
        this.stats.localML.success++;
        return {
          predictions: predictions.slice(0, 5),
          mappedResults,
          bestMatch: mappedResults[0],
          provider: this.localMLProvider.name
        };
      }

      // Return raw predictions even if no mapping found
      return {
        predictions: predictions.slice(0, 5),
        mappedResults: [],
        bestMatch: null,
        provider: this.localMLProvider.name
      };
    } catch (error) {
      this.stats.localML.failures++;
      console.error(`   ❌ Local ML failed:`, error.message);
      return null;
    }
  }

  _mapPredictionToCorkProduct(label) {
    if (!label || label.length === 0) return null;

    const lowerLabel = label.toLowerCase();

    // Direct mapping check
    if (CORK_PRODUCT_LABELS[lowerLabel]) {
      return CORK_PRODUCT_LABELS[lowerLabel];
    }

    // Partial match check - check if any key is contained in the label
    for (const [key, product] of Object.entries(CORK_PRODUCT_LABELS)) {
      if (lowerLabel.includes(key)) {
        return product;
      }
    }

    // Also check if label contains key (for compound words)
    for (const [key, product] of Object.entries(CORK_PRODUCT_LABELS)) {
      if (key.includes(lowerLabel) && lowerLabel.length > 2) {
        return product;
      }
    }

    return null;
  }

  // ==================== LAYER 1: HASH MATCHING ====================

  async findByHash(imageBuffer, threshold = 15) {
    const inputHash = await calculatePHash(imageBuffer);
    if (!inputHash) return null;

    const matches = [];
    for (const [storedHash, productId] of Object.entries(this.productIndex.hashes)) {
      const distance = hammingDistance(inputHash, storedHash);
      if (distance <= threshold) {
        // Tiered confidence based on hamming distance
        let confidence;
        if (distance < 10) {
          confidence = 0.95;
        } else if (distance < 15) {
          confidence = 0.75;
        } else {
          confidence = 1 - (distance / 64);
        }
        matches.push({
          productId,
          distance,
          confidence,
          product: this.productIndex.products[productId]
        });
      }
    }

    matches.sort((a, b) => a.distance - b.distance);

    if (matches.length > 0) {
      console.log(`🔍 Hash match: ${matches[0].product?.name} (distance: ${matches[0].distance}, confidence: ${(matches[0].confidence * 100).toFixed(0)}%)`);
    }

    return matches.length > 0 ? matches[0] : null;
  }

  // ==================== LAYER 2: VISUAL FEATURE MATCHING ====================

  async analyzeVisualFeatures(imageBuffer) {
    const [features, logoDetection, centerFeatures] = await Promise.all([
      extractImageFeatures(imageBuffer),
      detectLogo(imageBuffer),
      extractCenterRegionFeatures(imageBuffer)
    ]);

    if (!features) return null;

    const whiteBg = detectWhiteBackground(features, features.histogram);
    const categoryMatch = matchToCategory(features, centerFeatures, whiteBg.isWhiteBg);

    return {
      features,
      logoDetection,
      category: categoryMatch,
      centerFeatures,
      isWhiteBg: whiteBg.isWhiteBg,
      whiteBgConfidence: whiteBg.confidence
    };
  }

  // ==================== LAYER 3: VISION APIs ====================

  async callVisionAPI(providerId, imageBuffer, prompt) {
    const provider = VISION_PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const hasAllKeys = provider.configKeys.every(key => !!this.config[key]);
    if (!hasAllKeys) throw new Error(`${provider.name} not configured`);

    const base64 = imageBuffer.toString('base64');
    const requestConfig = provider.buildRequest(base64, prompt, this.config);

    console.log(`🔄 Trying ${provider.name}...`);

    try {
      const response = await axios(requestConfig);
      const parsed = provider.parseResponse(response);
      const result = provider.formatResult(parsed);

      this.stats.byProvider[providerId].success++;
      this.stats.totalSuccess++;
      console.log(`✅ ${provider.name} succeeded`);

      return { provider: providerId, response: result, success: true };
    } catch (error) {
      this.stats.byProvider[providerId].failures++;
      this.stats.totalFailures++;
      const errorMsg = error.response?.data?.error?.message || error.response?.data || error.message;
      console.error(`❌ ${provider.name} failed:`, errorMsg);
      throw error;
    }
  }

  async tryAllVisionAPIs(imageBuffer, prompt) {
    if (this.configuredProviders.length === 0) {
      throw new Error('No vision APIs configured');
    }

    console.log(`   ${this.configuredProviders.length} vision APIs available`);

    for (const provider of this.configuredProviders) {
      try {
        return await this.callVisionAPI(provider.id, imageBuffer, prompt);
      } catch (error) {
        console.log(`   ${provider.name} failed, trying next...`);
      }
    }

    throw new Error('All vision APIs failed');
  }

  // ==================== COMBINED IDENTIFICATION ====================

  async identifyImage(imageBuffer, userMessage = '') {
    console.log('🎯 Starting 4-layer image identification...');

    const results = {
      layer0_localML: null,
      layer1_hash: null,
      layer2_visual: null,
      layer3_api: null,
      finalResult: null
    };

    // Wait for hash index to be ready (loads from disk or builds)
    if (this.hashIndexPromise) {
      try { await this.hashIndexPromise; } catch (e) { /* hash index optional */ }
    }
    if (!this.indexLoaded) {
      await this.loadIndex();
    }

    // LAYER 0: Local ML Classification (fastest, no API calls)
    console.log('📍 Layer 0: Local ML classification...');

    // Wait for local ML to finish loading if still in progress
    if (this.localMLInitPromise && !this.localMLReady) {
      await this.localMLInitPromise;
    }

    if (this.localMLReady) {
      try {
        const mlResult = await this.classifyWithLocalML(imageBuffer);
        results.layer0_localML = mlResult;

        if (mlResult?.bestMatch && mlResult.bestMatch.confidence > 0.35) {
          const category = mlResult.bestMatch.corkCategory;
          const displayName = getCategoryDisplayName(category);

          if (category === 'cork_material') {
            results.finalResult = {
              method: 'local_ml_material',
              category: 'cork',
              confidence: mlResult.bestMatch.confidence,
              predictions: mlResult.predictions,
              message: "I can see this looks like cork material! Which product are you interested in - coasters, diaries, bags, or something else?"
            };
          } else {
            results.finalResult = {
              method: 'local_ml',
              category,
              confidence: mlResult.bestMatch.confidence,
              predictions: mlResult.predictions,
              message: `This looks like a ${displayName}! How many pieces do you need, and is this for personal use or corporate gifting?`
            };
          }
          console.log(`✅ Layer 0 match: ${category} (${(mlResult.bestMatch.confidence * 100).toFixed(0)}%) via ${mlResult.provider}`);
          return results;
        } else if (mlResult?.predictions?.length > 0) {
          console.log(`   Layer 0: Got predictions but no confident cork match`);
          console.log(`   Top prediction: ${mlResult.predictions[0]?.label} (${(mlResult.predictions[0]?.score * 100).toFixed(0)}%)`);
        }
      } catch (error) {
        console.log('   Layer 0 skipped:', error.message);
      }
    } else {
      console.log('   Layer 0 skipped: Local ML not available');
    }

    // LAYER 1: Hash Matching (instant)
    console.log('📍 Layer 1: Hash matching...');
    try {
      const hashMatch = await this.findByHash(imageBuffer);
      if (hashMatch && hashMatch.confidence > 0.7) {
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

    // LAYER 2: Visual Feature Analysis
    console.log('📍 Layer 2: Visual feature analysis...');
    try {
      const visualAnalysis = await this.analyzeVisualFeatures(imageBuffer);
      results.layer2_visual = visualAnalysis;

      if (visualAnalysis) {
        const { category, logoDetection, isWhiteBg, centerFeatures } = visualAnalysis;

        // High confidence logo detection (skip if white background - likely product photo)
        if (logoDetection.isLikeLogo && logoDetection.confidence > 0.5 && !isWhiteBg) {
          results.finalResult = {
            method: 'visual_logo',
            category: 'logo',
            confidence: logoDetection.confidence,
            message: "I see you've shared a logo/design! I can customize this on cork. Is this for corporate branding or a personal gift?"
          };
          console.log(`✅ Layer 2: Logo detected (${(logoDetection.confidence * 100).toFixed(0)}%)`);
          return results;
        }

        // Background-aware category boost
        let boostedConfidence = category.confidence;
        if (isWhiteBg && centerFeatures?.isCorkColored && category.category !== 'unknown') {
          boostedConfidence = Math.max(boostedConfidence, 0.8);
        }

        // High confidence category match (lowered threshold with background-awareness)
        if (boostedConfidence > 0.5 && category.category !== 'unknown') {
          const displayName = getCategoryDisplayName(category.category);
          results.finalResult = {
            method: 'visual_category',
            category: category.category,
            confidence: Math.min(boostedConfidence, 1),
            message: `This looks like a cork ${displayName}! How many pieces do you need, and is this for personal use or corporate gifting?`
          };
          console.log(`✅ Layer 2: ${category.category} (${(Math.min(boostedConfidence, 1) * 100).toFixed(0)}%)`);
          return results;
        }
      }
    } catch (error) {
      console.log('   Layer 2 error:', error.message);
    }

    // LAYER 3: Vision APIs
    console.log('📍 Layer 3: Vision API analysis...');
    if (this.configuredProviders.length > 0) {
      try {
        const prompt = this._buildVisionPrompt(userMessage);
        const apiResult = await this.tryAllVisionAPIs(imageBuffer, prompt);
        results.layer3_api = apiResult;
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
    }

    // FALLBACK: Use Layer 2 result with lower threshold
    if (results.layer2_visual?.category?.category !== 'unknown') {
      const cat = results.layer2_visual.category;
      results.finalResult = {
        method: 'visual_fallback',
        category: cat.category,
        confidence: cat.confidence,
        message: cat.category === 'logo'
          ? "Thanks for sharing this image! Which cork product would you like this design on?"
          : `I can see this might be related to ${getCategoryDisplayName(cat.category)}. Could you tell me more?`
      };
    } else {
      results.finalResult = {
        method: 'fallback',
        confidence: 0,
        message: "Thanks for the image! Could you tell me which cork product you're interested in - coasters, diaries, bags, or something else?"
      };
    }

    return results;
  }

  _buildVisionPrompt(userMessage) {
    return `You are Priya, a sales expert for 9Cork (sustainable cork products).
Analyze this image and respond helpfully in 1-2 short sentences.

Products: coasters, diaries, desk organizers, card holders, planters, bags, wallets, frames, clocks.

If cork product: identify it and ask about quantity.
If logo/design: say you can customize it on cork products.
If reference image: ask which cork product they want it on.

Customer message: ${userMessage || '(sent image)'}`;
  }

  // ==================== INDEX MANAGEMENT ====================

  async loadIndex() {
    if (this.indexLoaded) return;
    try {
      const data = await fs.readFile(this.indexPath, 'utf8');
      this.productIndex = JSON.parse(data);
      this.indexLoaded = true;
      console.log(`📦 Loaded index: ${Object.keys(this.productIndex.products).length} products`);
    } catch (error) {
      console.log('📦 No existing index, starting fresh');
      this.indexLoaded = true;
    }
  }

  async saveIndex() {
    this.productIndex.lastUpdated = new Date().toISOString();
    await fs.writeFile(this.indexPath, JSON.stringify(this.productIndex, null, 2));
    console.log('💾 Index saved');
  }

  async buildProductHashIndex() {
    const hashIndexPath = path.resolve(path.dirname(this.indexPath), 'product-hash-index.json');

    // Check if index exists and is fresh (< 7 days old)
    try {
      const stat = await fs.stat(hashIndexPath);
      const ageInDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageInDays < 7) {
        const data = JSON.parse(await fs.readFile(hashIndexPath, 'utf8'));
        if (data.hashes && Object.keys(data.hashes).length > 0) {
          this.productIndex = data;
          this.indexLoaded = true;
          console.log(`📦 Loaded hash index: ${Object.keys(data.hashes).length} hashes (${ageInDays.toFixed(1)} days old)`);
          return data;
        }
      }
    } catch { /* No existing index or stale */ }

    console.log('📦 Building product hash index...');

    let products;
    try {
      const productsPath = path.join(__dirname, 'scripts', 'products-data.json');
      products = JSON.parse(await fs.readFile(productsPath, 'utf8'));
    } catch (error) {
      console.log('📦 products-data.json not found, skipping hash index build');
      return null;
    }

    let indexed = 0;
    let failed = 0;

    for (const product of products) {
      if (!product.images || product.images.length === 0) continue;

      let imageUrl = product.images[0];

      // Convert Google Drive URLs
      const driveMatch = imageUrl.match(/drive\.google\.com\/file\/d\/([^/]+)/);
      if (driveMatch) {
        imageUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      }

      try {
        const imageBuffer = await this._downloadImageForIndex(imageUrl);
        if (imageBuffer) {
          const hash = await calculatePHash(imageBuffer);
          if (hash) {
            this.productIndex.hashes[hash] = product.productId;
            this.productIndex.products[product.productId] = {
              name: product.name,
              category: product.category,
              productId: product.productId
            };
            indexed++;
          }
        }
      } catch {
        failed++;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 50));
    }

    this.productIndex.lastUpdated = new Date().toISOString();
    this.indexLoaded = true;

    // Save to disk for reuse
    try {
      await fs.writeFile(hashIndexPath, JSON.stringify(this.productIndex, null, 2));
      console.log(`📦 Hash index built: ${indexed} products indexed, ${failed} failed, saved to disk`);
    } catch (error) {
      console.log(`📦 Hash index built: ${indexed} indexed, ${failed} failed (disk save failed: ${error.message})`);
    }

    return this.productIndex;
  }

  async _downloadImageForIndex(url, redirectCount = 0) {
    if (redirectCount > 5) throw new Error('Too many redirects');

    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });

      const buffer = Buffer.from(response.data);
      if (buffer.length < 1000) throw new Error('Too small');
      return buffer;
    } catch (error) {
      throw new Error(`Download failed: ${error.message}`);
    }
  }

  async indexProductImage(productId, productInfo, imageBuffer) {
    try {
      const hash = await calculatePHash(imageBuffer);
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

  getStats() {
    return {
      productsIndexed: Object.keys(this.productIndex.products).length,
      hashesStored: Object.keys(this.productIndex.hashes).length,
      lastUpdated: this.productIndex.lastUpdated,
      localMLProvider: this.localMLProvider?.name || 'None',
      localMLReady: this.localMLReady,
      configuredProviders: this.configuredProviders.map(p => p.name),
      stats: this.stats,
      architecture: {
        layer0: this.localMLProvider?.name || 'Disabled',
        layer1: 'Hash Matching (pHash)',
        layer2: 'Visual Features (color, shape, edges)',
        layer3: `${this.configuredProviders.length} API providers`
      }
    };
  }

  // Utility to check what local ML options are available
  static checkAvailableLocalML() {
    const results = {};
    for (const [id, provider] of Object.entries(LOCAL_ML_PROVIDERS)) {
      try {
        results[id] = {
          name: provider.name,
          available: provider.checkAvailable(),
          priority: provider.priority
        };
      } catch (error) {
        results[id] = { name: provider.name, available: false, error: error.message };
      }
    }
    return results;
  }
}

module.exports = SmartImageMatcher;
