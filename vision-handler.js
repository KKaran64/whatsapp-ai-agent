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
      console.error('❌ Gemini Vision failed:', error.message);
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
      console.error('❌ Claude Vision failed:', error.message);
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

      // Download image once
      const { base64, mimeType } = await this.downloadImage(mediaId);

      // Build prompt
      const conversationText = conversationHistory
        .map(msg => `${msg.role === 'user' ? 'Customer' : 'Priya'}: ${msg.content}`)
        .join('\n');

      const fullPrompt = `${systemPrompt}

IMPORTANT: Customer sent an IMAGE. Analyze it and respond.

Conversation History:
${conversationText}

Customer: ${userMessage}

Based on the image:
1. Cork product → Identify & suggest similar items
2. Logo → Offer customization quote
3. Quality issue → Sympathize & resolve
4. Unclear → Ask clarifying questions

Respond in 2 sentences as Priya.`;

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
