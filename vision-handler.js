// Vision Handler - Multi-Provider Image Recognition
// v53.42: 3-Layer Smart Matching (Hash → CLIP → 8+ Vision APIs)
// Fallback chain: Hash Match → Visual Analysis → Clarifai/Imagga/DeepAI/SambaNova/Cloudflare/Fireworks/OpenRouter/Hyperbolic → Together → Gemini
const axios = require('axios');
const sharp = require('sharp');
const LocalImageAnalyzer = require('./local-image-analyzer');
const SmartImageMatcher = require('./smart-image-matcher');

class VisionHandler {
  constructor(config) {
    this.whatsappToken = config.WHATSAPP_TOKEN;

    // v53.39: Local analyzer (color/shape analysis)
    this.localAnalyzer = new LocalImageAnalyzer();

    // v53.42: Smart Image Matcher (3-layer: Hash → CLIP → 8+ Vision APIs)
    this.smartMatcher = new SmartImageMatcher({
      // Tier 1: Dedicated Vision APIs
      CLARIFAI_API_KEY: config.CLARIFAI_API_KEY,
      IMAGGA_API_KEY: config.IMAGGA_API_KEY,
      IMAGGA_API_SECRET: config.IMAGGA_API_SECRET,
      DEEPAI_API_KEY: config.DEEPAI_API_KEY,
      // Tier 2: LLM Vision APIs
      SAMBANOVA_API_KEY: config.SAMBANOVA_API_KEY,
      CLOUDFLARE_ACCOUNT_ID: config.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: config.CLOUDFLARE_API_TOKEN,
      FIREWORKS_API_KEY: config.FIREWORKS_API_KEY,
      OPENROUTER_API_KEY: config.OPENROUTER_API_KEY,
      HYPERBOLIC_API_KEY: config.HYPERBOLIC_API_KEY
    });

    // Together AI (FREE Llama-Vision-Free)
    this.togetherApiKey = config.TOGETHER_API_KEY;

    // Gemini API keys (quota issues common)
    this.geminiApiKeys = config.GEMINI_API_KEY
      ? config.GEMINI_API_KEY.split(',').map(k => k.trim()).filter(Boolean)
      : [];

    this.anthropicApiKey = config.ANTHROPIC_API_KEY;
    this.googleCloudKey = config.GOOGLE_CLOUD_VISION_KEY;
    this.huggingFaceToken = config.HUGGINGFACE_TOKEN;

    // Check if any API keys are configured
    this.hasAnyApiKeys = config.CLARIFAI_API_KEY ||
                         config.IMAGGA_API_KEY ||
                         config.DEEPAI_API_KEY ||
                         config.SAMBANOVA_API_KEY ||
                         config.CLOUDFLARE_ACCOUNT_ID ||
                         config.FIREWORKS_API_KEY ||
                         config.OPENROUTER_API_KEY ||
                         config.HYPERBOLIC_API_KEY ||
                         this.togetherApiKey ||
                         this.geminiApiKeys.length > 0 ||
                         this.anthropicApiKey ||
                         this.googleCloudKey ||
                         this.huggingFaceToken;

    this.localOnlyMode = !this.hasAnyApiKeys;

    // Stats tracking
    this.stats = {
      smartMatcher: { success: 0, failures: 0 },
      local: { success: 0, failures: 0 },
      together: { success: 0, failures: 0 },
      gemini: { success: 0, failures: 0, keyStats: {} },
      claude: { success: 0, failures: 0 },
      googleCloud: { success: 0, failures: 0 },
      huggingFace: { success: 0, failures: 0 },
      fallback: { success: 0 }
    };

    // Initialize stats for Gemini keys
    this.geminiApiKeys.forEach((_, idx) => {
      this.stats.gemini.keyStats[`key${idx + 1}`] = { success: 0, failures: 0 };
    });

    console.log(`🔑 Vision Handler v53.42: Smart 3-Layer Matching (8+ APIs)`);
    console.log(`   Tier1: Clarifai=${!!config.CLARIFAI_API_KEY}, Imagga=${!!config.IMAGGA_API_KEY}, DeepAI=${!!config.DEEPAI_API_KEY}`);
    console.log(`   Tier2: SambaNova=${!!config.SAMBANOVA_API_KEY}, Cloudflare=${!!config.CLOUDFLARE_ACCOUNT_ID}, Fireworks=${!!config.FIREWORKS_API_KEY}`);
    console.log(`   Tier2: OpenRouter=${!!config.OPENROUTER_API_KEY}, Hyperbolic=${!!config.HYPERBOLIC_API_KEY}`);
    console.log(`   Legacy: Together=${!!this.togetherApiKey}, Gemini=${this.geminiApiKeys.length} keys`);
    if (this.localOnlyMode) {
      console.log(`   ⚠️ No API keys - LOCAL-ONLY mode`);
      console.log(`   💡 Get FREE keys: Clarifai (5k/mo), Imagga (1k/mo), or SambaNova (unlimited)`);
    }
  }

  // Download image from WhatsApp & optionally compress (v53.31 - DUAL APPROACH)
  async downloadImage(mediaId, compressIfNeeded = true) {
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { 'Authorization': `Bearer ${this.whatsappToken}` } }
    );

    const imageUrl = mediaResponse.data.url;
    const mimeType = mediaResponse.data.mime_type || 'image/jpeg';

    const imageResponse = await axios.get(imageUrl, {
      headers: { 'Authorization': `Bearer ${this.whatsappToken}` },
      responseType: 'arraybuffer'
    });

    let imageBuffer = Buffer.from(imageResponse.data);
    const originalSizeMB = (imageBuffer.length / (1024 * 1024)).toFixed(2);
    console.log(`📥 Downloaded image: ${originalSizeMB}MB, type: ${mimeType}`);

    // v53.31 OPTION 2: Auto-resize if > 3MB (prevents base64 bloat)
    const maxSizeMB = 3;
    if (compressIfNeeded && imageBuffer.length > maxSizeMB * 1024 * 1024) {
      console.log(`⚠️ Image too large (${originalSizeMB}MB), compressing...`);

      try {
        imageBuffer = await sharp(imageBuffer)
          .resize(1920, 1920, { // Max 1920x1920, maintains aspect ratio
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ quality: 85 }) // Convert to JPEG with 85% quality
          .toBuffer();

        const compressedSizeMB = (imageBuffer.length / (1024 * 1024)).toFixed(2);
        console.log(`✅ Compressed: ${originalSizeMB}MB → ${compressedSizeMB}MB`);
      } catch (error) {
        console.error('❌ Compression failed:', error.message);
        // Continue with original image
      }
    }

    return {
      base64: imageBuffer.toString('base64'),
      mimeType: mimeType,
      url: imageUrl, // Note: Requires WhatsApp Bearer token - not usable by external APIs
      sizeKB: Math.round(imageBuffer.length / 1024),
      compressed: imageBuffer.length < Buffer.from(imageResponse.data).length
    };
  }

  // v53.40: Try Together AI Vision (FREE - Llama-Vision-Free model)
  // Primary provider - most stable and free
  async tryTogetherVision(imageData, prompt) {
    if (!this.togetherApiKey) throw new Error('Together API key not configured');

    try {
      console.log(`🔵 Trying Together AI Vision (FREE)...`);
      console.log(`   📦 Using base64 (${imageData.sizeKB}KB)...`);

      // Use the FREE Llama Vision model
      const response = await axios.post(
        'https://api.together.xyz/v1/chat/completions',
        {
          model: 'meta-llama/Llama-Vision-Free', // FREE vision model
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${imageData.mimeType};base64,${imageData.base64}`
                }
              }
            ]
          }],
          max_tokens: 500,
          temperature: 0.4
        },
        {
          headers: {
            'Authorization': `Bearer ${this.togetherApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      if (!aiResponse) throw new Error('Empty response from Together AI');

      this.stats.together.success++;
      console.log(`✅ Together AI Vision succeeded`);
      return { provider: 'together-vision-free', response: aiResponse };

    } catch (error) {
      this.stats.together.failures++;

      // Log detailed error
      const errorMsg = error.response?.data?.error?.message || error.message;
      console.error(`❌ Together AI Vision failed:`, errorMsg);

      // If free model fails, try the turbo model
      if (error.response?.status === 404 || errorMsg.includes('not found')) {
        console.log(`   🔄 Trying turbo model as fallback...`);
        return this.tryTogetherVisionTurbo(imageData, prompt);
      }

      throw error;
    }
  }

  // Fallback: Together AI Turbo model (uses credits)
  async tryTogetherVisionTurbo(imageData, prompt) {
    try {
      const response = await axios.post(
        'https://api.together.xyz/v1/chat/completions',
        {
          model: 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo', // Paid but cheap
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } }
            ]
          }],
          max_tokens: 500,
          temperature: 0.4
        },
        {
          headers: {
            'Authorization': `Bearer ${this.togetherApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      if (!aiResponse) throw new Error('Empty response');

      this.stats.together.success++;
      console.log(`✅ Together AI Vision Turbo succeeded`);
      return { provider: 'together-vision-turbo', response: aiResponse };

    } catch (error) {
      console.error(`❌ Together AI Turbo also failed:`, error.response?.data?.error?.message || error.message);
      throw error;
    }
  }

  // Try Gemini Vision with base64 (v53.38 - FIXED: URL approach removed, WhatsApp URLs are authenticated)
  async tryGeminiVision(imageData, prompt, apiKey, keyIndex = 0) {
    if (!apiKey) throw new Error('Gemini API key not provided');

    try {
      console.log(`🟢 Trying Gemini Vision (key ${keyIndex + 1}/${this.geminiApiKeys.length})...`);
      console.log(`   📦 Using base64 (${imageData.sizeKB}KB, compressed: ${imageData.compressed})...`);

      // v53.38: Use stable gemini-2.0-flash model (1.5 deprecated Jan 2025)
      // Note: WhatsApp URLs require Bearer token auth - external APIs can't access them
      // Always use base64 for reliable image processing
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: imageData.mimeType, data: imageData.base64 } }
            ]
          }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 500
          }
        },
        { timeout: 30000 }
      );

      // Check for blocked responses (safety filters)
      if (response.data?.candidates?.[0]?.finishReason === 'SAFETY') {
        throw new Error('Response blocked by safety filters');
      }

      const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiResponse) throw new Error('Empty response from Gemini');

      this.stats.gemini.success++;
      this.stats.gemini.keyStats[`key${keyIndex + 1}`].success++;
      console.log(`✅ Gemini Vision succeeded with key ${keyIndex + 1}`);
      return { provider: `gemini-vision-key${keyIndex + 1}`, response: aiResponse };

    } catch (error) {
      this.stats.gemini.failures++;
      this.stats.gemini.keyStats[`key${keyIndex + 1}`].failures++;

      // Better error categorization
      const errorInfo = {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        reason: error.response?.data?.error?.message || 'Unknown'
      };

      console.error(`❌ Gemini Vision key ${keyIndex + 1} failed:`, errorInfo.reason);
      console.error('   Error details:', errorInfo);
      throw error;
    }
  }

  // Try Claude Vision - base64 only (v53.31 - uses compressed image)
  async tryClaudeVision(imageData, prompt) {
    if (!this.anthropicApiKey) throw new Error('Claude API key not configured');

    try {
      console.log(`🟣 Trying Claude Vision with base64 (${imageData.sizeKB}KB, compressed: ${imageData.compressed})...`);

      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: this.anthropicApiKey });

      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageData.mimeType,
                data: imageData.base64
              }
            },
            { type: 'text', text: prompt }
          ]
        }]
      });

      const aiResponse = response.content[0].text;
      if (!aiResponse) throw new Error('Empty response from Claude');

      this.stats.claude.success++;
      console.log('✅ Claude Vision succeeded');
      return { provider: 'claude-vision', response: aiResponse };

    } catch (error) {
      this.stats.claude.failures++;
      console.error('❌ Claude Vision failed:', error.response?.data || error.message);
      console.error('   Error details:', {
        status: error.response?.status,
        message: error.message
      });
      throw error;
    }
  }

  // Try Google Cloud Vision with base64 (v53.38 - FIXED: URL approach removed)
  async tryGoogleCloudVision(imageData) {
    if (!this.googleCloudKey) throw new Error('Google Cloud key not configured');

    try {
      console.log('🔵 Trying Google Cloud Vision...');
      console.log(`   📦 Using base64 (${imageData.sizeKB}KB, compressed: ${imageData.compressed})...`);

      // v53.38: Always use base64 - WhatsApp URLs require authentication
      const response = await axios.post(
        `https://vision.googleapis.com/v1/images:annotate?key=${this.googleCloudKey}`,
        {
          requests: [{
            image: { content: imageData.base64 },
            features: [
              { type: 'LABEL_DETECTION', maxResults: 8 },
              { type: 'OBJECT_LOCALIZATION', maxResults: 5 },
              { type: 'TEXT_DETECTION', maxResults: 3 }
            ]
          }]
        },
        { timeout: 30000 }
      );

      const result = response.data.responses[0];
      const labels = result?.labelAnnotations || [];
      const objects = result?.localizedObjectAnnotations || [];
      const textAnnotations = result?.textAnnotations || [];

      // Extract detected text (useful for logos/branded items)
      const detectedText = textAnnotations[0]?.description?.slice(0, 50) || '';

      const detectedItems = [
        ...labels.map(l => l.description),
        ...objects.map(o => o.name)
      ];

      // Build more helpful response
      let basicResponse = `I can see: ${detectedItems.slice(0, 4).join(', ')}.`;
      if (detectedText) {
        basicResponse += ` I also noticed text: "${detectedText}".`;
      }
      basicResponse += ` Which cork product are you interested in?`;

      this.stats.googleCloud.success++;
      console.log('✅ Google Cloud Vision succeeded');
      console.log(`   Detected: ${detectedItems.slice(0, 3).join(', ')}`);
      return { provider: 'google-cloud-vision', response: basicResponse };

    } catch (error) {
      this.stats.googleCloud.failures++;
      console.error('❌ Google Cloud Vision failed:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Error data:', JSON.stringify(error.response.data).slice(0, 500));
      }
      throw error;
    }
  }

  // Try Hugging Face Vision - base64 only (v53.31 - uses compressed image)
  async tryHuggingFaceVision(imageData) {
    if (!this.huggingFaceToken) throw new Error('Hugging Face token not configured');

    try {
      console.log(`🟠 Trying Hugging Face Vision with base64 (${imageData.sizeKB}KB, compressed: ${imageData.compressed})...`);

      // Convert base64 to binary buffer for HF API
      const imageBuffer = Buffer.from(imageData.base64, 'base64');

      // v53.36: Use newer BLIP-2 model (original BLIP deprecated with 410 error)
      // Force redeploy - Render stuck on old version
      const response = await axios.post(
        'https://api-inference.huggingface.co/models/Salesforce/blip2-opt-2.7b',
        imageBuffer,
        {
          headers: {
            'Authorization': `Bearer ${this.huggingFaceToken}`,
            'Content-Type': 'image/jpeg'
          },
          timeout: 60000 // 60 second timeout (model may need loading time)
        }
      );

      // v53.35: Handle different response formats (BLIP-2 vs BLIP)
      const caption = response.data?.[0]?.generated_text || response.data?.generated_text || response.data;
      if (!caption || typeof caption !== 'string') {
        console.error('   Unexpected response format:', JSON.stringify(response.data).slice(0, 200));
        throw new Error('Invalid response format from Hugging Face');
      }

      // Format caption into helpful response
      const basicResponse = `I can see: ${caption}. Which cork product are you interested in?`;

      this.stats.huggingFace.success++;
      console.log('✅ Hugging Face Vision succeeded');
      return { provider: 'huggingface-vision', response: basicResponse };

    } catch (error) {
      this.stats.huggingFace.failures++;
      console.error('❌ Hugging Face Vision failed:', error.message);
      // v53.34: Better error logging for debugging
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Error data:', JSON.stringify(error.response.data).slice(0, 500));
      }
      throw error;
    }
  }

  // Fallback response (when all vision APIs fail)
  getFallbackResponse(errorDetails = null) {
    this.stats.fallback.success++;

    // Log detailed error information for debugging
    if (errorDetails) {
      console.error('🚨 VISION FAILURE - All providers failed:');
      console.error('   Together AI:', errorDetails.together || 'Not attempted');
      console.error('   Gemini:', errorDetails.gemini || 'Not attempted');
      console.error('   Claude:', errorDetails.claude || 'Not attempted');
      console.error('   Google Cloud:', errorDetails.googleCloud || 'Not attempted');
      console.error('   Hugging Face:', errorDetails.huggingFace || 'Not attempted');
      console.error('   📋 Get FREE key: https://api.together.xyz');
    }

    // More helpful fallback message
    return "I received your reference image! While I process it, could you describe the design you're looking for? For example:\n\n• Simple text/logo or graphics/patterns?\n• Single color or multi-color printing?\n• Any specific fonts or icons?\n\nThis will help me prepare the exact customization you need! 🌿";
  }

  // Main handler with LOCAL-FIRST approach (v53.39)
  async handleImageMessage(mediaId, userMessage, phoneNumber, conversationHistory, systemPrompt) {
    try {
      console.log(`📸 Processing image: ${mediaId}`);
      console.log(`🔑 Mode: ${this.localOnlyMode ? 'LOCAL-ONLY' : 'Hybrid (Local + API)'}`);

      // v53.31: Download and auto-compress if needed
      const imageData = await this.downloadImage(mediaId);
      console.log(`✅ Image ready: ${imageData.mimeType}, ${imageData.sizeKB}KB${imageData.compressed ? ' (compressed)' : ''}`);

      // v53.41: STEP 1 - Try Smart 3-Layer Matching (Hash → CLIP → Vision APIs)
      const imageBuffer = Buffer.from(imageData.base64, 'base64');

      try {
        console.log(`🎯 Trying Smart Image Matcher (3-layer)...`);
        const smartResult = await this.smartMatcher.identifyImage(imageBuffer, userMessage);

        if (smartResult.finalResult && smartResult.finalResult.confidence > 0.5) {
          this.stats.smartMatcher.success++;
          console.log(`✅ Smart Matcher: ${smartResult.finalResult.method} (${(smartResult.finalResult.confidence * 100).toFixed(0)}%)`);
          return {
            provider: `smart-${smartResult.finalResult.method}`,
            response: smartResult.finalResult.message,
            imageProcessed: true,
            analysis: smartResult
          };
        }
      } catch (error) {
        console.log(`⚠️ Smart Matcher failed: ${error.message}`);
        this.stats.smartMatcher.failures++;
      }

      // v53.39: STEP 2 - Fall back to local analysis
      const localAnalysis = await this.localAnalyzer.analyzeImage(imageBuffer);
      const localResponse = this.localAnalyzer.generateResponse(localAnalysis, userMessage);

      console.log(`🖼️ Local analysis: type=${localResponse.type}, confidence=${localResponse.confidence.toFixed(2)}`);

      // Use local response if high confidence or local-only mode
      const useLocalResponse = this.localOnlyMode ||
                               localResponse.confidence >= 0.6 ||
                               localResponse.type === 'logo';

      if (useLocalResponse) {
        this.stats.local.success++;
        console.log(`✅ Using local analysis (confidence: ${localResponse.confidence.toFixed(2)})`);
        return {
          provider: 'local-analyzer',
          response: localResponse.response,
          imageProcessed: true,
          analysis: {
            type: localResponse.type,
            confidence: localResponse.confidence,
            detectedCategory: localResponse.detectedCategory
          }
        };
      }

      // v53.41: STEP 3 - Try additional APIs as final fallback
      console.log(`🔄 Local confidence low (${localResponse.confidence.toFixed(2)}), trying fallback APIs...`);

      // Build prompt for external APIs
      const conversationText = conversationHistory
        .slice(-3)
        .map(msg => `${msg.role === 'user' ? 'Customer' : 'Priya'}: ${msg.content}`)
        .join('\n');

      const fullPrompt = `You are Priya, a sales expert for 9Cork (sustainable cork products).

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

      const errorDetails = {};

      // v53.40: PRIORITY 1 - Together AI Vision (FREE Llama-Vision-Free)
      if (this.togetherApiKey) {
        try {
          const result = await this.tryTogetherVision(imageData, fullPrompt);
          return { ...result, imageProcessed: true };
        } catch (error) {
          errorDetails.together = error.message;
          console.log(`⚠️ Together AI failed, trying Gemini...`);
        }
      }

      // PRIORITY 2 - Gemini (quota issues common)
      if (this.geminiApiKeys.length > 0) {
        for (let i = 0; i < this.geminiApiKeys.length; i++) {
          try {
            const result = await this.tryGeminiVision(imageData, fullPrompt, this.geminiApiKeys[i], i);
            return { ...result, imageProcessed: true };
          } catch (error) {
            errorDetails.gemini = (errorDetails.gemini || '') + `Key${i + 1}: ${error.message}; `;
          }
        }
      }

      // PRIORITY 3 - Claude (paid)
      if (this.anthropicApiKey) {
        try {
          const result = await this.tryClaudeVision(imageData, fullPrompt);
          return { ...result, imageProcessed: true };
        } catch (error) {
          errorDetails.claude = error.message;
        }
      }

      // PRIORITY 4 - Google Cloud Vision
      if (this.googleCloudKey) {
        try {
          const result = await this.tryGoogleCloudVision(imageData);
          return { ...result, imageProcessed: true };
        } catch (error) {
          errorDetails.googleCloud = error.message;
        }
      }

      // PRIORITY 5 - Hugging Face
      if (this.huggingFaceToken) {
        try {
          const result = await this.tryHuggingFaceVision(imageData);
          return { ...result, imageProcessed: true };
        } catch (error) {
          errorDetails.huggingFace = error.message;
        }
      }

      // v53.39: STEP 4 - Fall back to local response if all APIs fail
      console.log(`⚠️ All APIs failed, using local analysis as fallback`);
      this.stats.local.success++;
      return {
        provider: 'local-analyzer-fallback',
        response: localResponse.response,
        imageProcessed: true,
        analysis: {
          type: localResponse.type,
          confidence: localResponse.confidence,
          apiErrors: errorDetails
        }
      };

    } catch (error) {
      console.error('❌ Vision handler critical error:', error.message);
      console.error('   Stack:', error.stack);
      return {
        provider: 'fallback',
        response: this.getFallbackResponse({ critical: error.message }),
        imageProcessed: false
      };
    }
  }

  // Get stats
  getStats() {
    return this.stats;
  }
}

module.exports = VisionHandler;
