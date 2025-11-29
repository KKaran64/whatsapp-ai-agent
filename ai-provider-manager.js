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

    // Common queries with instant responses
    const commonResponses = {
      'hi': '👋 Welcome to 9 Cork Sustainable Products! What brings you here - personal use, corporate gifting, or for your business?',
      'hello': '👋 Hello! I\'m from 9 Cork Sustainable Products. Are you looking for retail items, corporate gifts, or HORECA solutions?',
      'price': 'I\'d love to help with pricing! What product are you interested in, and how many pieces are you looking for?',
      'catalog': 'I\'d be happy to share our catalog! Please share your email or WhatsApp number and I\'ll send you detailed product images right away. 🌿',
      'catalogue': 'I\'d be happy to share our catalog! Please share your email or WhatsApp number and I\'ll send you detailed product images right away. 🌿',
    };

    // Check exact matches
    for (const [key, response] of Object.entries(commonResponses)) {
      if (normalizedMsg.includes(key)) {
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

        if (error.message?.includes('rate_limit')) {
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
      throw error;
    }
  }

  // Fallback to rule-based responses
  getFallbackResponse(userMessage) {
    console.log('⚪ Using fallback response...');

    const msg = userMessage.toLowerCase();

    // Greetings
    if (msg.includes('hi') || msg.includes('hello') || msg.includes('hey')) {
      return "👋 Welcome to 9 Cork Sustainable Products! We make premium eco-friendly cork products. Are you looking for retail items, corporate gifts, or HORECA solutions? 🌿";
    }

    // Product inquiries - HORECA
    if (msg.includes('horeca') || msg.includes('hotel') || msg.includes('restaurant') || msg.includes('cafe')) {
      return "Great! We specialize in HORECA cork products - coasters, placemats, serving trays, bar caddies, tissue holders, napkin rings, and more. What's your requirement? Share quantity and I'll help! 🏨";
    }

    // Product inquiries - Coasters
    if (msg.includes('coaster')) {
      return "We have 15+ cork coaster designs (round, square, hexagon, with veneers) starting from ₹22-120 for 100 pieces. What quantity do you need and is this for personal or business use? 🌿";
    }

    // Product inquiries - Planters
    if (msg.includes('planter')) {
      return "Our cork planters range from ₹130-900 (test tube planters, table top, magnetic, bark planters). How many pieces and what size are you looking for? 🌱";
    }

    // Product inquiries - Diaries
    if (msg.includes('diary') || msg.includes('diaries') || msg.includes('notebook')) {
      return "We offer premium cork diaries: A6 (₹90), A5 (₹135), Printed A5 (₹240) for 100 pieces. What quantity and size do you need? 📔";
    }

    // Product inquiries - Trays
    if (msg.includes('tray')) {
      return "We have 30+ cork tray designs - serving trays, placemats, premium trays with MDF base (₹150-600). For HORECA or personal use? What quantity? 🍽️";
    }

    // Product inquiries - Corporate/Bulk
    if (msg.includes('corporate') || msg.includes('bulk') || msg.includes('gifting')) {
      return "Perfect! We specialize in corporate gifting. We offer combo sets, branded products with logo, and bulk discounts (15-25% off for 100+ pieces). What products interest you? 🎁";
    }

    // Pricing inquiries
    if (msg.includes('price') || msg.includes('cost') || msg.includes('rate')) {
      return "I'd love to help with pricing! Please share: (1) Which product? (2) Quantity needed? (3) Do you need logo branding? This helps me give you accurate pricing! 💰";
    }

    // Logo/branding
    if (msg.includes('logo') || msg.includes('branding') || msg.includes('customiz') || msg.includes('print')) {
      return "Yes! We can add your logo on any product. Single color logos are standard, multi-color is available too. What product and quantity are you considering? 🎨";
    }

    // Catalog
    if (msg.includes('catalog') || msg.includes('catalogue') || msg.includes('picture') || msg.includes('image') || msg.includes('photo')) {
      return "I'd be happy to share our full catalog! Please share your email or WhatsApp number and I'll send detailed product images and price lists right away. 📸🌿";
    }

    // Contact/Email
    if (msg.includes('email') || msg.includes('contact') || msg.includes('phone') || msg.includes('whatsapp')) {
      return "📞 You can reach us at:\n• WhatsApp: +91 70090 52784\n• Email: info@9cork.com\n• Website: www.9cork.com\n\nHow can I help you today? 🌿";
    }

    // Default - More helpful fallback
    this.stats.fallback.success++;
    return "Thanks for contacting 9 Cork Sustainable Products! 🌿\n\nWe make premium cork coasters, diaries, planters, trays, and HORECA products.\n\nTo help you better, please share:\n1. Which product interests you?\n2. Quantity needed?\n3. For personal use, corporate gifting, or HORECA?\n\nOr share your email for our full catalog! 📧";
  }

  // Main method: Try all providers with fallbacks
  async getResponse(systemPrompt, conversationHistory, userMessage) {
    // 1. Check cache first
    const cachedResponse = this.checkCache(userMessage);
    if (cachedResponse) {
      console.log('⚡ Cache hit - instant response');
      return { provider: 'cache', response: cachedResponse };
    }

    // 2. Try Groq FIRST (Primary - FREE & Most Reliable)
    try {
      return await this.tryGroq(systemPrompt, conversationHistory, userMessage);
    } catch (error) {
      console.log('❌ Groq failed:', error.message);
    }

    // 3. Try Gemini (Secondary - FREE but may have rate limits)
    try {
      return await this.tryGemini(systemPrompt, conversationHistory, userMessage);
    } catch (error) {
      console.log('❌ Gemini failed:', error.message);
    }

    // 4. Try Claude (Tertiary - PAID but reliable)
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
