// Multi-Provider AI Manager with Fallbacks
// Handles Groq, Gemini, and Claude with automatic failover

const Groq = require('groq-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

class AIProviderManager {
  constructor(config) {
    this.config = config;

    // Initialize Groq with multiple keys support (up to 4 keys)
    this.groqKeys = [];
    if (config.GROQ_API_KEY) this.groqKeys.push(config.GROQ_API_KEY);
    if (config.GROQ_API_KEY_2) this.groqKeys.push(config.GROQ_API_KEY_2);
    if (config.GROQ_API_KEY_3) this.groqKeys.push(config.GROQ_API_KEY_3);
    if (config.GROQ_API_KEY_4) this.groqKeys.push(config.GROQ_API_KEY_4);

    this.groqClients = this.groqKeys.map(key => new Groq({ apiKey: key }));
    this.currentGroqIndex = 0;

    // Initialize other providers
    this.anthropic = config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
    this.geminiApiKey = config.GEMINI_API_KEY;

    // Track usage and failures
    this.stats = {
      groq: { success: 0, failures: 0, lastFailure: null, keyRotations: 0 },
      gemini: { success: 0, failures: 0, lastFailure: null },
      claude: { success: 0, failures: 0, lastFailure: null },
      fallback: { success: 0 }
    };

    // Common query cache (in-memory - could use Redis)
    this.responseCache = new Map();
  }

  // Get next Groq client (round-robin rotation)
  getNextGroqClient() {
    if (this.groqClients.length === 0) return null;
    const client = this.groqClients[this.currentGroqIndex];
    this.currentGroqIndex = (this.currentGroqIndex + 1) % this.groqClients.length;
    if (this.currentGroqIndex === 0 && this.groqClients.length > 1) {
      this.stats.groq.keyRotations++;
    }
    return client;
  }

  // Check cache for common queries
  checkCache(message) {
    const normalizedMsg = message.toLowerCase().trim();

    // CRITICAL: Only cache EXACT greetings, not messages that contain greetings + product questions
    // "hi" → cache ✅  |  "hi do you have coasters" → NO cache, send to AI ✅
    const exactGreetings = {
      'hi': '👋 Welcome to 9 Cork Sustainable Products! What brings you here - personal use, corporate gifting, or for your business?',
      'hello': '👋 Hello! I\'m from 9 Cork Sustainable Products. Are you looking for retail items, corporate gifts, or HORECA solutions?',
      'hey': '👋 Welcome to 9 Cork Sustainable Products! What brings you here - personal use, corporate gifting, or for your business?',
    };

    // Check EXACT match for greetings only
    if (exactGreetings[normalizedMsg]) {
      console.log('⚡ Cache hit - exact greeting match');
      return exactGreetings[normalizedMsg];
    }

    // For all other queries, check partial matches (but NOT greetings)
    const partialMatchResponses = {
      'catalog': 'I\'d be happy to share our catalog! Please share your email or WhatsApp number and I\'ll send you detailed product images right away. 🌿',
      'catalogue': 'I\'d be happy to share our catalog! Please share your email or WhatsApp number and I\'ll send you detailed product images right away. 🌿',
    };

    // Check partial matches for non-greeting queries
    for (const [key, response] of Object.entries(partialMatchResponses)) {
      if (normalizedMsg.includes(key)) {
        console.log(`⚡ Cache hit - partial match for "${key}"`);
        return response;
      }
    }

    // Check cache
    if (this.responseCache.has(normalizedMsg)) {
      const cached = this.responseCache.get(normalizedMsg);
      if (Date.now() - cached.timestamp < 10800000) { // 3 hour cache (extended from 1 hour)
        return cached.response;
      }
    }

    return null;
  }

  // Try Groq (PRIMARY - Free) with automatic key rotation
  async tryGroq(systemPrompt, conversationHistory, userMessage) {
    const maxRetries = this.groqClients.length;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const groqClient = this.getNextGroqClient();
      if (!groqClient) {
        throw new Error('No Groq API keys configured');
      }

      try {
        console.log(`🔵 Trying Groq (key ${this.currentGroqIndex || this.groqClients.length}/${this.groqClients.length})...`);

        const messages = [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
          { role: 'user', content: userMessage }
        ];

        const completion = await groqClient.chat.completions.create({
          messages,
          model: 'llama-3.3-70b-versatile',
          temperature: 0.7,
          max_tokens: 500,
          top_p: 1,
          stream: false
        });

        const response = completion.choices[0]?.message?.content || "I'm here to help!";
        this.stats.groq.success++;

        // Cache the response
        this.cacheResponse(userMessage, response);

        return { provider: 'groq', response };
      } catch (error) {
        lastError = error;

        // DETAILED ERROR LOGGING
        console.error(`❌ Groq Error (key ${this.currentGroqIndex || this.groqClients.length}):`);
        console.error('Error message:', error.message);
        console.error('Error response:', error.response?.data || error.response || 'No response data');
        console.error('Error status:', error.response?.status || 'No status');
        console.error('Error stack:', error.stack);

        if (error.message?.includes('rate_limit') || error.response?.status === 429) {
          console.log(`⚠️ Groq key ${this.currentGroqIndex || this.groqClients.length} rate limit hit, trying next key...`);
          continue; // Try next key
        } else {
          // Non-rate-limit error, don't retry
          this.stats.groq.failures++;
          this.stats.groq.lastFailure = new Date();
          throw error;
        }
      }
    }

    // All keys exhausted
    this.stats.groq.failures++;
    this.stats.groq.lastFailure = new Date();
    console.log('⚠️ All Groq keys rate limited');
    throw new Error('RATE_LIMIT');
  }

  // Try Google Gemini (SECONDARY - Free)
  async tryGemini(systemPrompt, conversationHistory, userMessage) {
    if (!this.geminiApiKey) {
      throw new Error('Gemini API key not configured');
    }

    try {
      console.log('🟢 Trying Gemini...');

      // Build conversation for Gemini
      const conversationText = conversationHistory
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n');

      const fullPrompt = `${systemPrompt}\n\nConversation:\n${conversationText}\n\nUser: ${userMessage}\n\nAssistant:`;

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [{
            parts: [{ text: fullPrompt }]
          }]
        }
      );

      const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "I'm here to help!";
      this.stats.gemini.success++;

      // Cache the response
      this.cacheResponse(userMessage, aiResponse);

      return { provider: 'gemini', response: aiResponse };
    } catch (error) {
      this.stats.gemini.failures++;
      this.stats.gemini.lastFailure = new Date();

      // DETAILED ERROR LOGGING
      console.error('❌ Gemini Error:');
      console.error('Error message:', error.message);
      console.error('Error response:', error.response?.data || error.response || 'No response data');
      console.error('Error status:', error.response?.status || 'No status');

      if (error.response?.status === 429) {
        console.log('⚠️ Gemini rate limit hit');
        throw new Error('RATE_LIMIT');
      }
      throw error;
    }
  }

  // Try Anthropic Claude (TERTIARY - Paid but most reliable)
  async tryClaude(systemPrompt, conversationHistory, userMessage) {
    if (!this.anthropic) {
      throw new Error('Claude API key not configured');
    }

    try {
      console.log('🟣 Trying Claude...');

      const response = await this.anthropic.messages.create({
        model: 'claude-3-haiku-20240307', // Cheapest Claude model
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          ...conversationHistory,
          { role: 'user', content: userMessage }
        ]
      });

      const aiResponse = response.content[0].text || "I'm here to help!";
      this.stats.claude.success++;

      // Cache the response
      this.cacheResponse(userMessage, aiResponse);

      return { provider: 'claude', response: aiResponse };
    } catch (error) {
      this.stats.claude.failures++;
      this.stats.claude.lastFailure = new Date();

      // DETAILED ERROR LOGGING
      console.error('❌ Claude Error:');
      console.error('Error message:', error.message);
      console.error('Error response:', error.response?.data || error.response || 'No response data');
      console.error('Error status:', error.response?.status || 'No status');
      console.error('Error type:', error.error?.type || 'No type');

      throw error;
    }
  }

  // Fallback to rule-based responses (ONLY for greetings and educational questions)
  getFallbackResponse(userMessage) {
    console.log('⚪ Using LIMITED fallback response (AI providers failed)...');

    const msg = userMessage.toLowerCase();

    // Cork material knowledge questions (educational - OK for fallback)
    if (msg.includes('what is cork') || msg.includes('what\'s cork') || (msg.includes('cork') && (msg.includes('material') || msg.includes('made of') || msg.includes('about cork')))) {
      return "Cork is the bark of the Cork Oak tree - harvested sustainably without cutting the tree down! The bark regenerates every 9-10 years, and each harvest helps the tree absorb MORE CO2. It's 100% natural, biodegradable, water-resistant, and durable. What draws you to cork products? 🌳";
    }

    // Sustainability questions (educational - OK for fallback)
    if (msg.includes('sustainability') || msg.includes('sustainable') || msg.includes('eco-friendly') || msg.includes('environment')) {
      return "That's exactly why cork is special! Cork oak trees absorb 5x more CO2 after each harvest, and forests sequester 14 million tons annually. Unlike plastic (450+ years to decompose), cork biodegrades naturally in months. Are you exploring cork for personal use or corporate gifting? 🌍";
    }

    // Greetings ONLY (no context needed)
    if (msg === 'hi' || msg === 'hello' || msg === 'hey') {
      return "👋 Welcome to 9 Cork Sustainable Products! We make premium eco-friendly cork products. Are you looking for retail items, corporate gifts, or HORECA solutions? 🌿";
    }

    // Contact/Email (informational - no context needed)
    if (msg.includes('email') || msg.includes('contact') || msg.includes('phone') || msg.includes('whatsapp')) {
      return "📞 You can reach us at:\n• WhatsApp: +91 70090 52784\n• Email: info@9cork.com\n• Website: www.9cork.com\n\nHow can I help you today? 🌿";
    }

    // CRITICAL: ALL OTHER MESSAGES SHOULD FAIL TO AI
    // This includes product inquiries, pricing, HORECA, etc. which NEED conversation context
    // Don't provide misleading context-free responses!
    this.stats.fallback.success++;
    console.error('❌ ALL AI providers failed! Returning error message instead of context-free fallback');
    return "I'm having trouble processing your message right now. Could you please rephrase or provide more details about what you're looking for? 🌿";
  }

  // Main method: Try all providers with fallbacks
  async getResponse(systemPrompt, conversationHistory, userMessage) {
    // 1. Check cache first
    const cachedResponse = this.checkCache(userMessage);
    if (cachedResponse) {
      console.log('⚡ Cache hit - instant response');
      return { provider: 'cache', response: cachedResponse };
    }

    // 2. Try Groq FIRST (Primary - FREE & Fast)
    try {
      return await this.tryGroq(systemPrompt, conversationHistory, userMessage);
    } catch (error) {
      console.log('❌ Groq failed:', error.message);
    }

    // 3. Try Gemini (Secondary - FREE fallback)
    try {
      return await this.tryGemini(systemPrompt, conversationHistory, userMessage);
    } catch (error) {
      console.log('❌ Gemini failed:', error.message);
    }

    // 4. Try Claude (Tertiary - PAID, only if configured)
    try {
      return await this.tryClaude(systemPrompt, conversationHistory, userMessage);
    } catch (error) {
      console.log('❌ Claude failed:', error.message);
    }

    // 5. Fallback to rule-based
    const fallbackResponse = this.getFallbackResponse(userMessage);
    return { provider: 'fallback', response: fallbackResponse };
  }

  // Cache response
  cacheResponse(message, response) {
    const normalizedMsg = message.toLowerCase().trim();
    this.responseCache.set(normalizedMsg, {
      response,
      timestamp: Date.now()
    });

    // Limit cache size
    if (this.responseCache.size > 1000) {
      const firstKey = this.responseCache.keys().next().value;
      this.responseCache.delete(firstKey);
    }
  }

  // Get statistics
  getStats() {
    return {
      providers: this.stats,
      cacheSize: this.responseCache.size,
      totalRequests: Object.values(this.stats).reduce((sum, stat) =>
        sum + (stat.success || 0) + (stat.failures || 0), 0
      )
    };
  }
}

module.exports = AIProviderManager;
