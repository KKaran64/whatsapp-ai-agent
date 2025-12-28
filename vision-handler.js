// Vision Handler - Multi-Provider Image Recognition (Condensed)
// Gemini Vision (free) → Claude Vision (paid) → Google Cloud Vision (free tier)
const axios = require('axios');

class VisionHandler {
  constructor(config) {
    this.whatsappToken = config.WHATSAPP_TOKEN;
    this.geminiApiKey = config.GEMINI_API_KEY;
    this.anthropicApiKey = config.ANTHROPIC_API_KEY;
    this.googleCloudKey = config.GOOGLE_CLOUD_VISION_KEY;

    // Stats tracking
    this.stats = {
      gemini: { success: 0, failures: 0 },
      claude: { success: 0, failures: 0 },
      googleCloud: { success: 0, failures: 0 },
      fallback: { success: 0 }
    };
  }

  // Download image from WhatsApp & convert to base64
  async downloadImage(mediaId) {
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { 'Authorization': `Bearer ${this.whatsappToken}` } }
    );

    const imageResponse = await axios.get(mediaResponse.data.url, {
      headers: { 'Authorization': `Bearer ${this.whatsappToken}` },
      responseType: 'arraybuffer'
    });

    return {
      base64: Buffer.from(imageResponse.data).toString('base64'),
      mimeType: mediaResponse.data.mime_type || 'image/jpeg'
    };
  }

  // Try Gemini Vision (PRIMARY - Free)
  async tryGeminiVision(base64Image, mimeType, prompt) {
    if (!this.geminiApiKey) throw new Error('Gemini API key not configured');

    try {
      console.log('🟢 Trying Gemini Vision...');

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Image } }
            ]
          }]
        }
      );

      const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiResponse) throw new Error('Empty response from Gemini');

      this.stats.gemini.success++;
      return { provider: 'gemini-vision', response: aiResponse };

    } catch (error) {
      this.stats.gemini.failures++;
      console.error('❌ Gemini Vision failed:', error.response?.data || error.message);
      console.error('   Error details:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message
      });
      throw error;
    }
  }

  // Try Claude Vision (SECONDARY - Paid but reliable)
  async tryClaudeVision(base64Image, mimeType, prompt) {
    if (!this.anthropicApiKey) throw new Error('Claude API key not configured');

    try {
      console.log('🟣 Trying Claude Vision...');

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
                media_type: mimeType,
                data: base64Image
              }
            },
            { type: 'text', text: prompt }
          ]
        }]
      });

      const aiResponse = response.content[0].text;
      if (!aiResponse) throw new Error('Empty response from Claude');

      this.stats.claude.success++;
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

  // Try Google Cloud Vision (TERTIARY - Free tier, basic labels)
  async tryGoogleCloudVision(base64Image) {
    if (!this.googleCloudKey) throw new Error('Google Cloud key not configured');

    try {
      console.log('🔵 Trying Google Cloud Vision...');

      const response = await axios.post(
        `https://vision.googleapis.com/v1/images:annotate?key=${this.googleCloudKey}`,
        {
          requests: [{
            image: { content: base64Image },
            features: [
              { type: 'LABEL_DETECTION', maxResults: 5 },
              { type: 'OBJECT_LOCALIZATION', maxResults: 3 }
            ]
          }]
        }
      );

      const labels = response.data.responses[0]?.labelAnnotations || [];
      const objects = response.data.responses[0]?.localizedObjectAnnotations || [];

      const detectedItems = [
        ...labels.map(l => l.description),
        ...objects.map(o => o.name)
      ];

      const basicResponse = `I can see: ${detectedItems.slice(0, 3).join(', ')}. Could you tell me more about what you're looking for?`;

      this.stats.googleCloud.success++;
      return { provider: 'google-cloud-vision', response: basicResponse };

    } catch (error) {
      this.stats.googleCloud.failures++;
      console.error('❌ Google Cloud Vision failed:', error.message);
      throw error;
    }
  }

  // Fallback response (when all vision APIs fail)
  getFallbackResponse() {
    this.stats.fallback.success++;
    return "I received your image! However, I'm having trouble analyzing it. Could you describe what you're looking for? I can help with cork products, customization, or answer questions! 🌿";
  }

  // Main handler with multi-provider fallback
  async handleImageMessage(mediaId, userMessage, phoneNumber, conversationHistory, systemPrompt) {
    try {
      console.log(`📸 Processing image: ${mediaId}`);
      console.log(`🔑 API Keys configured: Gemini=${!!this.geminiApiKey}, Claude=${!!this.anthropicApiKey}, GoogleCloud=${!!this.googleCloudKey}`);

      // Download image once
      const { base64, mimeType } = await this.downloadImage(mediaId);
      console.log(`✅ Image downloaded: ${mimeType}, size=${Math.round(base64.length / 1024)}KB`);

      // Build prompt
      const conversationText = conversationHistory
        .map(msg => `${msg.role === 'user' ? 'Customer' : 'Priya'}: ${msg.content}`)
        .join('\n');

      const fullPrompt = `${systemPrompt}

IMPORTANT: Customer sent an IMAGE. Analyze it carefully and identify the 9 Cork product.

🔍 VISUAL PRODUCT IDENTIFICATION GUIDE (9cork.com):

**COASTERS** (Round, 10cm diameter unless noted):
- Heart Coasters: Round with heart-shaped patterns, cutouts, or embossed hearts
- Leaf Coasters: Round with leaf patterns, leaf-shaped cutouts, or botanical designs
- Hexagon Coasters: 6-sided geometric shape (not round)
- Bread Coasters: Textured surface resembling bread texture
- Set of 4 with Case: Multiple coasters with storage box/case
- Premium Square Fabric: Square shape with fabric backing
- Olive/Chocochip/Natural: Natural cork texture with visible grain patterns

**DIARIES & NOTEBOOKS**:
- Cork Diary: Book-like with pages visible, cork cover (front/back), may have elastic band closure
- A5 Diary: Larger (21x15cm), thick cork cover
- A6 Diary: Smaller (15x10.5cm), pocket-sized
- Look for: Binding, pages, elastic band, pen loop

**DESK ORGANIZERS**:
- Multiple compartments for pens/pencils/items
- 3D structure (not flat), stands upright
- May have sections, dividers, or slots
- Desk Organizer vs Pen Holder: Organizer has multiple compartments, pen holder is single cylinder/section

**CARD HOLDERS**:
- Card Holder (₹120): Wallet-style, folds, holds credit/debit cards in slots, pocket-sized
- Business Card Case (₹95): Flat box/case for storing business cards on desk (NOT a wallet)
- Look for: Slots/pockets (Card Holder) vs box shape (Business Card Case)

**PLANTERS**:
- Test Tube Planters: Cork base with glass test tubes for plants/flowers
- Fridge Magnet Planter: Small, compact (16.5x4.5x4.5cm), has magnet backing
- Table Top Planters: Cork pot/container for plants (10x10cm typically)
- Look for: Test tubes, plant space, decorative patterns

**BAGS & WALLETS**:
- Laptop Bag/Sleeve: Large, rectangular, for laptop storage
- Wallets: Bi-fold (folds once), Tri-fold (folds twice)
- Clutch: Small handbag, no straps
- Tote/Handbag: Has handles or shoulder straps

**OTHER PRODUCTS**:
- Photo Frames: Cork border around photo opening (4x6, 5x7, 8x10 sizes)
- Serving Trays: Flat surface with raised edges or handles
- Table Mats/Placemats: Flat, rectangular, for dining
- Mouse Pad: Flat, rectangular, desk accessory
- Clocks: Round or square, has clock face/hands
- Yoga Mat: Large rolled mat

Conversation History:
${conversationText}

Customer: ${userMessage}

IDENTIFICATION STEPS:
1. Analyze shape, size, structure (flat/3D, round/square/rectangular)
2. Look for distinctive features (hearts, leaves, compartments, pages, test tubes)
3. Check for functional clues (holds cards, has pens, stores items)
4. Match to specific product from guide above
5. If product has multiple variants (like coasters), identify the specific type

Based on the image analysis:
- If CORK PRODUCT → Identify exact product name and ask qualification questions
- If LOGO → "I can customize that! Single or multi-color logo?"
- If QUALITY ISSUE → Sympathize and ask for details
- If UNCLEAR → Ask what they're looking for

Respond in 2 sentences maximum as Priya (sales expert).`;

      // Try providers in order: Gemini → Claude → Google Cloud → Fallback

      // 1. Try Gemini Vision (FREE)
      try {
        const result = await this.tryGeminiVision(base64, mimeType, fullPrompt);
        return { ...result, imageProcessed: true };
      } catch (error) {
        console.log('⚠️ Gemini Vision unavailable, trying Claude...');
      }

      // 2. Try Claude Vision (PAID - only if enabled)
      if (this.anthropicApiKey) {
        try {
          const result = await this.tryClaudeVision(base64, mimeType, fullPrompt);
          return { ...result, imageProcessed: true };
        } catch (error) {
          console.log('⚠️ Claude Vision unavailable, trying Google Cloud...');
        }
      }

      // 3. Try Google Cloud Vision (FREE TIER - basic detection)
      if (this.googleCloudKey) {
        try {
          const result = await this.tryGoogleCloudVision(base64);
          return { ...result, imageProcessed: true };
        } catch (error) {
          console.log('⚠️ Google Cloud Vision unavailable, using fallback...');
        }
      }

      // 4. Fallback response
      return {
        provider: 'fallback',
        response: this.getFallbackResponse(),
        imageProcessed: false
      };

    } catch (error) {
      console.error('❌ Vision handler error:', error.message);
      return {
        provider: 'fallback',
        response: this.getFallbackResponse(),
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
