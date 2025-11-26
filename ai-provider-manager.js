// Multi-Provider AI Manager with Fallbacks
// Handles Groq, Gemini, and Claude with automatic failover

const Groq = require('groq-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

class AIProviderManager {
  constructor(config) {
    this.config = config;

    // Initialize providers
    this.groq = new Groq({ apiKey: config.GROQ_API_KEY });
    this.anthropic = config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
    this.geminiApiKey = config.GEMINI_API_KEY;

    // Track usage and failures
    this.stats = {
      groq: { success: 0, failures: 0, lastFailure: null },
      gemini: { success: 0, failures: 0, lastFailure: null },
      claude: { success: 0, failures: 0, lastFailure: null },
      fallback: { success: 0 }
    };

    // Common query cache (in-memory - could use Redis)
    this.responseCache = new Map();
  }

  // Check cache for common queries
  checkCache(message) {
    const normalizedMsg = message.toLowerCase().trim();

    // Common queries with instant responses
    const commonResponses = {
      'hi': '👋 Welcome! We make sustainable cork products. What brings you here - personal use, corporate gifting, or for your business?',
      'hello': '👋 Hello! We specialize in eco-friendly cork products. Are you looking for retail items, corporate gifts, or HORECA solutions?',
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
      if (Date.now() - cached.timestamp < 3600000) { // 1 hour cache
        return cached.response;
      }
    }

    return null;
  }

  // Try Groq (PRIMARY - Free)
  async tryGroq(systemPrompt, conversationHistory, userMessage) {
    try {
      console.log('🔵 Trying Groq...');

      const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: userMessage }
      ];

      const completion = await this.groq.chat.completions.create({
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
      this.stats.groq.failures++;
      this.stats.groq.lastFailure = new Date();

      if (error.message?.includes('rate_limit')) {
        console.log('⚠️ Groq rate limit hit');
        throw new Error('RATE_LIMIT');
      }
      throw error;
    }
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

    // Product inquiries
    if (msg.includes('coaster')) {
      return "We have a wide range of cork coasters starting from ₹22 for 100 pieces. What quantity are you looking for? 🌿";
    }
    if (msg.includes('planter')) {
      return "Our cork planters are perfect for eco-friendly spaces, starting at ₹130. How many pieces do you need? 🌱";
    }
    if (msg.includes('diary') || msg.includes('diaries')) {
      return "We offer premium cork diaries starting from ₹90 for A6 and ₹135 for A5. What quantity are you considering? 📔";
    }

    // Pricing inquiries
    if (msg.includes('price') || msg.includes('cost')) {
      return "I'd love to help with pricing! What product are you interested in, and how many pieces are you looking for?";
    }

    // Logo/branding
    if (msg.includes('logo') || msg.includes('branding') || msg.includes('customiz')) {
      return "Yes! We can add your logo. Is it a single color or multi-color logo? Also, what quantity are you thinking?";
    }

    // Catalog
    if (msg.includes('catalog') || msg.includes('picture') || msg.includes('image')) {
      return "I'd be happy to share our catalog! Please share your email and I'll send you detailed product images right away. 🌿";
    }

    // Default
    this.stats.fallback.success++;
    return "Thank you for your message! I'm currently experiencing technical difficulties. Please share your email or contact details, and I'll get back to you with full product information within a few hours. 🌿";
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
