// Vision Handler - Image Recognition & Processing for WhatsApp
// Handles image download, vision AI analysis, and image sending

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class VisionHandler {
  constructor(config) {
    this.config = config;
    this.whatsappToken = config.WHATSAPP_TOKEN;
    this.geminiApiKey = config.GEMINI_API_KEY;
    this.phoneNumberId = config.PHONE_NUMBER_ID;
  }

  // Download image from WhatsApp servers
  async downloadWhatsAppImage(mediaId) {
    try {
      console.log(`📥 Downloading image with media ID: ${mediaId}`);

      // Step 1: Get media URL from WhatsApp
      const mediaResponse = await axios.get(
        `https://graph.facebook.com/v18.0/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`
          }
        }
      );

      const mediaUrl = mediaResponse.data.url;
      console.log(`📍 Media URL retrieved: ${mediaUrl.substring(0, 50)}...`);

      // Step 2: Download actual image file
      const imageResponse = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.whatsappToken}`
        },
        responseType: 'arraybuffer'
      });

      // Convert to base64 for AI processing
      const base64Image = Buffer.from(imageResponse.data).toString('base64');
      const mimeType = mediaResponse.data.mime_type || 'image/jpeg';

      console.log(`✅ Image downloaded successfully (${mimeType}, ${base64Image.length} bytes)`);

      return {
        base64: base64Image,
        mimeType: mimeType
      };
    } catch (error) {
      console.error('❌ Error downloading WhatsApp image:', error.message);
      throw error;
    }
  }

  // Analyze image using Gemini Vision
  async analyzeImageWithGemini(imageBase64, mimeType, userMessage, conversationHistory, systemPrompt) {
    try {
      console.log('🔍 Analyzing image with Gemini Vision...');

      // Build conversation context
      const conversationText = conversationHistory
        .map(msg => `${msg.role === 'user' ? 'Customer' : 'Priya'}: ${msg.content}`)
        .join('\n');

      const fullPrompt = `${systemPrompt}

IMPORTANT: Customer sent an IMAGE. Analyze it and respond based on what they're asking.

Conversation History:
${conversationText}

Customer's current message: ${userMessage}

Based on the image, identify:
1. If it's a cork product → Name the product, suggest similar items
2. If it's a logo → Acknowledge and offer customization quote
3. If it's a quality issue → Sympathize and offer resolution
4. If unclear → Ask clarifying questions

Respond in 2-3 sentences as Priya.`;

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [{
            parts: [
              { text: fullPrompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: imageBase64
                }
              }
            ]
          }]
        }
      );

      const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                        "I can see your image! Could you tell me more about what you're looking for? 🌿";

      console.log(`✅ Gemini Vision response: ${aiResponse.substring(0, 100)}...`);

      return aiResponse;
    } catch (error) {
      console.error('❌ Gemini Vision error:', error.response?.data || error.message);

      // Fallback response
      return "I see you've sent an image! Could you describe what you're looking for? I can help identify cork products, review logos for customization, or answer questions about our catalog. 🌿";
    }
  }

  // Send image to WhatsApp user (for catalog/examples)
  async sendWhatsAppImage(toPhoneNumber, imageUrl, caption = '') {
    try {
      console.log(`📤 Sending image to ${toPhoneNumber}...`);

      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toPhoneNumber,
          type: 'image',
          image: {
            link: imageUrl,
            caption: caption
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ Image sent successfully');
      return response.data;
    } catch (error) {
      console.error('❌ Error sending image:', error.response?.data || error.message);
      throw error;
    }
  }

  // Main handler for processing image messages
  async handleImageMessage(mediaId, userMessage, phoneNumber, conversationHistory, systemPrompt) {
    try {
      // Download image from WhatsApp
      const { base64, mimeType } = await this.downloadWhatsAppImage(mediaId);

      // Analyze with Gemini Vision
      const response = await this.analyzeImageWithGemini(
        base64,
        mimeType,
        userMessage || 'What is this?',
        conversationHistory,
        systemPrompt
      );

      return {
        provider: 'gemini-vision',
        response: response,
        imageProcessed: true
      };
    } catch (error) {
      console.error('❌ Error handling image message:', error.message);

      // Fallback response if vision fails
      return {
        provider: 'fallback',
        response: "I received your image! However, I'm having trouble analyzing it right now. Could you describe what you're looking for? I can help with cork products, customization, or answer any questions! 🌿",
        imageProcessed: false
      };
    }
  }
}

module.exports = VisionHandler;
