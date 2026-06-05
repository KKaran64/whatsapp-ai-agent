// Vision Handler v2 - Optimized Multi-Provider Image Recognition
// v54.0: Consolidated architecture, reduced redundancy, generic provider pattern

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { compressImage, extractImageFeatures, matchToCategory, detectLogo, getCategoryDisplayName } = require('./vision-utils');
const SmartImageMatcher = require('./smart-image-matcher');

// Persistent stats file path
const STATS_FILE = path.join(__dirname, 'vision-stats.json');

// Legacy provider configurations (Together, Gemini, Claude, Google Cloud, HuggingFace)
const LEGACY_PROVIDERS = {
  together: {
    name: 'Together AI',
    models: ['meta-llama/Llama-Vision-Free', 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo'],
    buildRequest: (base64, mimeType, prompt, apiKey, modelIndex = 0) => ({
      method: 'POST',
      url: 'https://api.together.xyz/v1/chat/completions',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      data: {
        model: LEGACY_PROVIDERS.together.models[modelIndex],
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]}],
        max_tokens: 500,
        temperature: 0.4
      },
      timeout: 30000
    }),
    parseResponse: (response) => response.data?.choices?.[0]?.message?.content
  },

  gemini: {
    name: 'Gemini',
    execute: async (config) => {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(config.apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { temperature: 0.4, maxOutputTokens: 500 }
      });
      const result = await model.generateContent([
        config.prompt,
        { inlineData: { mimeType: config.mimeType, data: config.base64 } }
      ]);
      const text = result.response.text();
      if (!text) throw new Error('Empty response from Gemini');
      return text;
    },
    buildRequest: (base64, mimeType, prompt, apiKey) => ({ base64, mimeType, prompt, apiKey })
  },

  claude: {
    name: 'Claude',
    buildRequest: async (base64, mimeType, prompt, apiKey) => {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      return { client, base64, mimeType, prompt };
    },
    execute: async (config) => {
      const response = await config.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: config.mimeType, data: config.base64 } },
          { type: 'text', text: config.prompt }
        ]}]
      });
      return response.content[0].text;
    }
  },

  googleCloud: {
    name: 'Google Cloud Vision',
    buildRequest: (base64, mimeType, prompt, apiKey) => ({
      method: 'POST',
      url: `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      data: {
        requests: [{
          image: { content: base64 },
          features: [
            { type: 'LABEL_DETECTION', maxResults: 8 },
            { type: 'OBJECT_LOCALIZATION', maxResults: 5 },
            { type: 'TEXT_DETECTION', maxResults: 3 }
          ]
        }]
      },
      timeout: 30000
    }),
    parseResponse: (response) => {
      const result = response.data.responses[0];
      const labels = result?.labelAnnotations?.map(l => l.description) || [];
      const objects = result?.localizedObjectAnnotations?.map(o => o.name) || [];
      const text = result?.textAnnotations?.[0]?.description?.slice(0, 50) || '';
      return { labels, objects, text };
    },
    formatResponse: (parsed) => {
      const items = [...parsed.labels, ...parsed.objects].slice(0, 4);
      let response = `I can see: ${items.join(', ')}.`;
      if (parsed.text) response += ` I also noticed text: "${parsed.text}".`;
      return response + ' Which cork product are you interested in?';
    }
  },

  huggingFace: {
    name: 'Hugging Face',
    buildRequest: (base64, mimeType, prompt, apiKey) => ({
      method: 'POST',
      url: 'https://api-inference.huggingface.co/models/Salesforce/blip2-opt-2.7b',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'image/jpeg' },
      data: Buffer.from(base64, 'base64'),
      timeout: 60000
    }),
    parseResponse: (response) => {
      const caption = response.data?.[0]?.generated_text || response.data?.generated_text || response.data;
      if (!caption || typeof caption !== 'string') throw new Error('Invalid response format');
      return caption;
    },
    formatResponse: (caption) => `I can see: ${caption}. Which cork product are you interested in?`
  }
};

class VisionHandler {
  constructor(config) {
    this.whatsappToken = config.WHATSAPP_TOKEN;

    // Initialize Smart Image Matcher (handles Tier 1 & 2 APIs)
    this.smartMatcher = new SmartImageMatcher({
      CLARIFAI_API_KEY: config.CLARIFAI_API_KEY,
      IMAGGA_API_KEY: config.IMAGGA_API_KEY,
      IMAGGA_API_SECRET: config.IMAGGA_API_SECRET,
      DEEPAI_API_KEY: config.DEEPAI_API_KEY,
      SAMBANOVA_API_KEY: config.SAMBANOVA_API_KEY,
      CLOUDFLARE_ACCOUNT_ID: config.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: config.CLOUDFLARE_API_TOKEN,
      FIREWORKS_API_KEY: config.FIREWORKS_API_KEY,
      OPENROUTER_API_KEY: config.OPENROUTER_API_KEY,
      HYPERBOLIC_API_KEY: config.HYPERBOLIC_API_KEY
    });

    // Legacy API keys
    this.togetherApiKey = config.TOGETHER_API_KEY;
    this.geminiApiKeys = config.GEMINI_API_KEY?.split(',').map(k => k.trim()).filter(Boolean) || [];
    this.anthropicApiKey = config.ANTHROPIC_API_KEY;
    this.googleCloudKey = config.GOOGLE_CLOUD_VISION_KEY;
    this.huggingFaceToken = config.HUGGINGFACE_TOKEN;

    // Check if any API keys are configured
    this.hasAnyApiKeys = this.smartMatcher.configuredProviders.length > 0 ||
                         this.togetherApiKey ||
                         this.geminiApiKeys.length > 0 ||
                         this.anthropicApiKey ||
                         this.googleCloudKey ||
                         this.huggingFaceToken;

    this.localOnlyMode = !this.hasAnyApiKeys;

    // Stats tracking with latency
    this.stats = this._loadStats();

    // Save stats periodically (every 5 minutes)
    this._statsSaveInterval = setInterval(() => this._saveStats(), 5 * 60 * 1000);

    this._logConfig(config);
  }

  _logConfig(config) {
    console.log(`🔑 Vision Handler v2: Optimized Multi-Provider`);
    console.log(`   Smart Matcher: ${this.smartMatcher.configuredProviders.length} APIs`);
    console.log(`   Legacy: Together=${!!this.togetherApiKey}, Gemini=${this.geminiApiKeys.length}, Claude=${!!this.anthropicApiKey}`);
    if (this.localOnlyMode) {
      console.log(`   ⚠️ No API keys - LOCAL-ONLY mode`);
    }
  }

  // Load persistent stats from file
  _loadStats() {
    const defaultStats = {
      startedAt: new Date().toISOString(),
      lastUpdated: null,
      totalImages: 0,
      providers: {
        smartMatcher: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 },
        local: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 },
        together: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 },
        gemini: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 },
        claude: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 },
        googleCloud: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 },
        huggingFace: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 },
        fallback: { success: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 }
      },
      latency: {
        min: null,
        max: null,
        avg: 0,
        total: 0,
        count: 0
      },
      byType: {
        product: 0,
        logo: 0,
        reference: 0,
        unknown: 0
      },
      recentImages: [] // Last 20 images processed
    };

    try {
      if (fs.existsSync(STATS_FILE)) {
        const data = fs.readFileSync(STATS_FILE, 'utf8');
        const loaded = JSON.parse(data);
        console.log(`📊 Loaded vision stats: ${loaded.totalImages} images processed`);
        return { ...defaultStats, ...loaded };
      }
    } catch (error) {
      console.warn('⚠️ Could not load vision stats:', error.message);
    }
    return defaultStats;
  }

  // Save stats to file
  _saveStats() {
    try {
      this.stats.lastUpdated = new Date().toISOString();
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats, null, 2));
      console.log(`💾 Vision stats saved: ${this.stats.totalImages} images`);
    } catch (error) {
      console.warn('⚠️ Could not save vision stats:', error.message);
    }
  }

  // Record latency for a provider
  _recordLatency(providerId, latencyMs, success, imageType = 'unknown') {
    const provider = this.stats.providers[providerId];
    if (!provider) return;

    if (success) {
      provider.success++;
      provider.totalLatencyMs += latencyMs;
      provider.avgLatencyMs = Math.round(provider.totalLatencyMs / provider.success);
    } else {
      provider.failures++;
    }

    // Update global latency stats
    this.stats.latency.count++;
    this.stats.latency.total += latencyMs;
    this.stats.latency.avg = Math.round(this.stats.latency.total / this.stats.latency.count);
    if (this.stats.latency.min === null || latencyMs < this.stats.latency.min) {
      this.stats.latency.min = latencyMs;
    }
    if (this.stats.latency.max === null || latencyMs > this.stats.latency.max) {
      this.stats.latency.max = latencyMs;
    }

    // Update type stats
    if (success && this.stats.byType[imageType] !== undefined) {
      this.stats.byType[imageType]++;
    }

    // Track recent images (keep last 20)
    this.stats.recentImages.unshift({
      timestamp: new Date().toISOString(),
      provider: providerId,
      latencyMs,
      success,
      type: imageType
    });
    if (this.stats.recentImages.length > 20) {
      this.stats.recentImages.pop();
    }

    this.stats.totalImages++;
  }

  // Download and optionally compress image from WhatsApp
  async downloadImage(mediaId) {
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { 'Authorization': `Bearer ${this.whatsappToken}` } }
    );

    const imageResponse = await axios.get(mediaResponse.data.url, {
      headers: { 'Authorization': `Bearer ${this.whatsappToken}` },
      responseType: 'arraybuffer'
    });

    let imageBuffer = Buffer.from(imageResponse.data);
    const mimeType = mediaResponse.data.mime_type || 'image/jpeg';
    const originalSize = imageBuffer.length;

    console.log(`📥 Downloaded: ${(originalSize / 1024 / 1024).toFixed(2)}MB, ${mimeType}`);

    // Compress if needed
    const { buffer, compressed } = await compressImage(imageBuffer);

    return {
      base64: buffer.toString('base64'),
      mimeType,
      sizeKB: Math.round(buffer.length / 1024),
      compressed
    };
  }

  // Generic legacy provider caller
  async _callLegacyProvider(providerId, imageData, prompt, apiKey, options = {}) {
    const provider = LEGACY_PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    console.log(`🔄 Trying ${provider.name}...`);
    const startTime = Date.now();

    try {
      let response;

      if (provider.execute) {
        // SDK-based execution (Gemini SDK, Claude SDK)
        const config = await provider.buildRequest(imageData.base64, imageData.mimeType, prompt, apiKey);
        response = await provider.execute(config);
      } else {
        // Standard axios request
        const requestConfig = provider.buildRequest(
          imageData.base64,
          imageData.mimeType,
          prompt,
          apiKey,
          options.modelIndex
        );
        const axiosResponse = await axios(requestConfig);
        response = provider.parseResponse(axiosResponse);

        if (provider.formatResponse) {
          response = provider.formatResponse(response);
        }
      }

      if (!response) throw new Error('Empty response');

      const latencyMs = Date.now() - startTime;
      this._recordLatency(providerId, latencyMs, true);
      console.log(`✅ ${provider.name} succeeded (${latencyMs}ms)`);
      return { provider: providerId, response, success: true, latencyMs };

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this._recordLatency(providerId, latencyMs, false);
      const errorMsg = error.response?.data?.error?.message || error.message;
      console.error(`❌ ${provider.name} failed:`, errorMsg);

      // Try fallback model for Together AI
      if (providerId === 'together' && options.modelIndex === 0) {
        console.log('   Trying turbo model...');
        return this._callLegacyProvider(providerId, imageData, prompt, apiKey, { modelIndex: 1 });
      }

      throw error;
    }
  }

  // Build the vision prompt
  _buildPrompt(conversationHistory, userMessage) {
    const conversationText = conversationHistory
      ?.slice(-3)
      .map(msg => `${msg.role === 'user' ? 'Customer' : 'Priya'}: ${msg.content}`)
      .join('\n') || '';

    return `You are Priya, a sales expert for 9Cork (sustainable cork products).

TASK: Analyze this image and respond helpfully.

PRODUCT CATEGORIES (9cork.com):
• Coasters (round, hexagon, heart-shaped, leaf pattern)
• Diaries/Notebooks (A5, A6 sizes with cork covers)
• Desk Organizers & Pen Holders
• Card Holders & Business Card Cases
• Planters (test tube, fridge magnet, tabletop)
• Bags, Wallets, Clutches
• Photo Frames, Clocks, Yoga Mats, Mouse Pads

IMAGE TYPES TO HANDLE:
1. CORK PRODUCT → Identify it specifically and ask: quantity needed + purpose (personal/corporate gift)
2. LOGO/DESIGN → Say: "I can customize that on cork! Is this for branding or a personal gift?"
3. REFERENCE IMAGE → Say: "Thanks for the reference! Which cork product would you like this design on?"
4. UNCLEAR → Ask: "Interesting! What cork product are you looking for?"

${conversationText ? `Recent conversation:\n${conversationText}\n` : ''}Customer message: ${userMessage || '(sent image)'}

Respond in 1-2 short sentences as Priya.`;
  }

  // Local analysis fallback
  async _performLocalAnalysis(imageBuffer) {
    const [features, logoDetection] = await Promise.all([
      extractImageFeatures(imageBuffer),
      detectLogo(imageBuffer)
    ]);

    if (!features) return null;

    const category = matchToCategory(features);

    // Determine response based on analysis
    if (logoDetection.isLikeLogo && logoDetection.confidence > 0.5) {
      return {
        type: 'logo',
        confidence: logoDetection.confidence,
        response: "I see you've shared a logo/design! I can customize this on cork products. Is this for corporate branding or a personal gift?"
      };
    }

    if (features.isCorkColored?.isCork && category.confidence > 0.4) {
      const displayName = getCategoryDisplayName(category.category);
      return {
        type: 'product',
        confidence: features.isCorkColored.confidence * category.confidence,
        detectedCategory: category.category,
        response: `This looks like a cork ${displayName}! How many pieces do you need, and is this for personal use or corporate gifting?`
      };
    }

    if (features.isCorkColored?.isCork) {
      return {
        type: 'cork_unknown',
        confidence: features.isCorkColored.confidence,
        response: "I can see this is a cork product! Could you tell me which specific item you're interested in?"
      };
    }

    return {
      type: 'reference',
      confidence: 0.5,
      response: "Thanks for the reference image! Which cork product would you like this design on?"
    };
  }

  // Main handler
  async handleImageMessage(mediaId, userMessage, phoneNumber, conversationHistory, systemPrompt) {
    const totalStartTime = Date.now();

    try {
      console.log(`📸 Processing image: ${mediaId}`);
      console.log(`🔑 Mode: ${this.localOnlyMode ? 'LOCAL-ONLY' : 'Hybrid'}`);

      const imageData = await this.downloadImage(mediaId);
      const imageBuffer = Buffer.from(imageData.base64, 'base64');

      console.log(`✅ Image ready: ${imageData.mimeType}, ${imageData.sizeKB}KB${imageData.compressed ? ' (compressed)' : ''}`);

      // STEP 1: Try Smart Matcher (3-layer: Hash → Visual → APIs)
      const smartStartTime = Date.now();
      try {
        console.log(`🎯 Smart Image Matcher...`);
        const smartResult = await this.smartMatcher.identifyImage(imageBuffer, userMessage);

        if (smartResult.finalResult && smartResult.finalResult.confidence > 0.5) {
          const latencyMs = Date.now() - smartStartTime;
          const imageType = smartResult.finalResult.category || 'product';
          this._recordLatency('smartMatcher', latencyMs, true, imageType);
          console.log(`✅ Smart Matcher: ${smartResult.finalResult.method} (${(smartResult.finalResult.confidence * 100).toFixed(0)}%) [${latencyMs}ms]`);
          return {
            provider: `smart-${smartResult.finalResult.method}`,
            response: smartResult.finalResult.message,
            imageProcessed: true,
            latencyMs,
            analysis: smartResult
          };
        }
      } catch (error) {
        const latencyMs = Date.now() - smartStartTime;
        this._recordLatency('smartMatcher', latencyMs, false);
        console.log(`⚠️ Smart Matcher failed: ${error.message} [${latencyMs}ms]`);
      }

      // STEP 2: Local analysis
      const localStartTime = Date.now();
      const localAnalysis = await this._performLocalAnalysis(imageBuffer);
      const localLatency = Date.now() - localStartTime;
      console.log(`🖼️ Local: type=${localAnalysis?.type}, confidence=${localAnalysis?.confidence?.toFixed(2)} [${localLatency}ms]`);

      // Use local if high confidence or local-only mode
      if (this.localOnlyMode || (localAnalysis && localAnalysis.confidence >= 0.6)) {
        this._recordLatency('local', localLatency, true, localAnalysis?.type || 'unknown');
        console.log(`✅ Using local analysis [${localLatency}ms]`);
        return {
          provider: 'local-analyzer',
          response: localAnalysis?.response || this._getFallbackResponse(),
          imageProcessed: true,
          latencyMs: localLatency,
          analysis: localAnalysis
        };
      }

      // STEP 3: Try legacy APIs as fallback
      console.log(`🔄 Trying legacy APIs...`);
      const prompt = this._buildPrompt(conversationHistory, userMessage);
      const errorDetails = {};

      // Priority order: Together → Gemini → Claude → Google Cloud → HuggingFace
      const legacyAttempts = [
        { id: 'together', key: this.togetherApiKey },
        ...this.geminiApiKeys.map((key, i) => ({ id: 'gemini', key, keyIndex: i })),
        { id: 'claude', key: this.anthropicApiKey },
        { id: 'googleCloud', key: this.googleCloudKey },
        { id: 'huggingFace', key: this.huggingFaceToken }
      ];

      for (const attempt of legacyAttempts) {
        if (!attempt.key) continue;

        try {
          const result = await this._callLegacyProvider(attempt.id, imageData, prompt, attempt.key);
          return { ...result, imageProcessed: true };
        } catch (error) {
          errorDetails[attempt.id] = error.message;
        }
      }

      // STEP 4: Fall back to local response
      const totalLatency = Date.now() - totalStartTime;
      this._recordLatency('fallback', totalLatency, true, localAnalysis?.type || 'unknown');
      console.log(`⚠️ All APIs failed, using local fallback [${totalLatency}ms total]`);
      return {
        provider: 'local-fallback',
        response: localAnalysis?.response || this._getFallbackResponse(),
        imageProcessed: true,
        latencyMs: totalLatency,
        analysis: { ...localAnalysis, apiErrors: errorDetails }
      };

    } catch (error) {
      const totalLatency = Date.now() - totalStartTime;
      this._recordLatency('fallback', totalLatency, false);
      console.error(`❌ Critical error: ${error.message} [${totalLatency}ms]`);
      return {
        provider: 'fallback',
        response: this._getFallbackResponse(),
        imageProcessed: false,
        latencyMs: totalLatency
      };
    }
  }

  _getFallbackResponse() {
    return "I received your reference image! While I process it, could you describe the design you're looking for? For example:\n\n• Simple text/logo or graphics/patterns?\n• Single color or multi-color printing?\n• Any specific fonts or icons?\n\nThis will help me prepare the exact customization you need!";
  }

  getStats() {
    // Calculate success rate
    const totalSuccess = Object.values(this.stats.providers).reduce((sum, p) => sum + p.success, 0);
    const totalFailures = Object.values(this.stats.providers).reduce((sum, p) => sum + p.failures, 0);
    const successRate = totalSuccess + totalFailures > 0
      ? ((totalSuccess / (totalSuccess + totalFailures)) * 100).toFixed(1)
      : 0;

    return {
      ...this.stats,
      summary: {
        totalImages: this.stats.totalImages,
        successRate: `${successRate}%`,
        avgLatencyMs: this.stats.latency.avg,
        minLatencyMs: this.stats.latency.min,
        maxLatencyMs: this.stats.latency.max
      },
      smartMatcher: this.smartMatcher.getStats()
    };
  }

  // Force save stats (call on shutdown)
  shutdown() {
    if (this._statsSaveInterval) {
      clearInterval(this._statsSaveInterval);
    }
    this._saveStats();
    console.log('📊 Vision stats saved on shutdown');
  }
}

module.exports = VisionHandler;
