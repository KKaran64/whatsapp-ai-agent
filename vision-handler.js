// Vision Handler - Image Recognition & Processing (Condensed)
const axios = require('axios');

class VisionHandler {
  constructor(config) {
    this.whatsappToken = config.WHATSAPP_TOKEN;
    this.geminiApiKey = config.GEMINI_API_KEY;
  }

  // Download & analyze image in one method
  async handleImageMessage(mediaId, userMessage, phoneNumber, conversationHistory, systemPrompt) {
    try {
      console.log(`📸 Processing image: ${mediaId}`);

      // Step 1: Get media URL from WhatsApp
      const mediaResponse = await axios.get(
        `https://graph.facebook.com/v18.0/${mediaId}`,
        { headers: { 'Authorization': `Bearer ${this.whatsappToken}` } }
      );

      // Step 2: Download image as base64
      const imageResponse = await axios.get(mediaResponse.data.url, {
        headers: { 'Authorization': `Bearer ${this.whatsappToken}` },
        responseType: 'arraybuffer'
      });

      const base64Image = Buffer.from(imageResponse.data).toString('base64');
      const mimeType = mediaResponse.data.mime_type || 'image/jpeg';

      // Step 3: Analyze with Gemini Vision
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

      const visionResponse = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [{
            parts: [
              { text: fullPrompt },
              { inline_data: { mime_type: mimeType, data: base64Image } }
            ]
          }]
        }
      );

      const aiResponse = visionResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                        "I can see your image! Could you tell me more about what you're looking for? 🌿";

      console.log(`✅ Vision response: ${aiResponse.substring(0, 80)}...`);

      return {
        provider: 'gemini-vision',
        response: aiResponse,
        imageProcessed: true
      };

    } catch (error) {
      console.error('❌ Vision error:', error.message);

      // Fallback response
      return {
        provider: 'fallback',
        response: "I received your image! However, I'm having trouble analyzing it. Could you describe what you're looking for? 🌿",
        imageProcessed: false
      };
    }
  }
}

module.exports = VisionHandler;
