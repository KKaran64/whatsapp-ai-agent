/**
 * Router Agent for Token-Optimized Bot
 *
 * Minimal classification prompt (~80 tokens) that routes messages to conversation nodes.
 * Uses Groq for fast, low-latency classification.
 *
 * Nodes:
 * - START: Initial greeting/unknown intent
 * - COASTERS: Cork coaster inquiries
 * - DESK_ORGANIZER: Desk organizer inquiries
 * - WALL_TILES: Wall tile inquiries
 * - YOGA_MAT: Yoga mat inquiries
 * - LAMPSHADE: Lampshade inquiries
 * - PHOTOS: User sent photo (image analysis)
 * - QUOTE_REQUEST: Pricing/bulk order inquiry
 * - CAPTURE_LEAD: Ready to collect contact info
 * - HORECA: Hotel/restaurant/bar products
 * - FALLBACK: Off-topic or unclear
 */

const Groq = require('groq-sdk');
const { MODELS } = require('../config/models');

// Classification prompt (~80 tokens)
const ROUTER_PROMPT = `Classify this WhatsApp message for cork products store.
Output ONLY the node name, nothing else.

Nodes:
- START: greetings (hi/hello/hey)
- COASTERS: coaster/coasters
- DESK_ORGANIZER: desk organizer/pen holder/desk accessory
- WALL_TILES: wall tiles/cork tiles/wall decor
- YOGA_MAT: yoga mat/yoga block/yoga
- LAMPSHADE: lamp/lampshade/light
- PHOTOS: [IMAGE] or photo request
- QUOTE_REQUEST: price/cost/quote/bulk/how much/rate
- CAPTURE_LEAD: ready to order/confirm/proceed/book
- HORECA: hotel/restaurant/cafe/bar/caddy/bill folder/menu
- FALLBACK: unclear/off-topic

Examples:
"hi" -> START
"do you have coasters" -> COASTERS
"price for 100 diaries" -> QUOTE_REQUEST
"yes proceed" -> CAPTURE_LEAD
"[IMAGE]" -> PHOTOS`;

class RouterAgent {
  constructor(config) {
    // Initialize Groq clients for key rotation
    this.groqKeys = [];
    if (config.GROQ_API_KEY) this.groqKeys.push(config.GROQ_API_KEY);
    if (config.GROQ_API_KEY_2) this.groqKeys.push(config.GROQ_API_KEY_2);
    if (config.GROQ_API_KEY_3) this.groqKeys.push(config.GROQ_API_KEY_3);
    if (config.GROQ_API_KEY_4) this.groqKeys.push(config.GROQ_API_KEY_4);

    this.groqClients = this.groqKeys.map(key => new Groq({ apiKey: key }));
    this.currentKeyIndex = 0;

    this.stats = {
      classifications: 0,
      cacheHits: 0,
      errors: 0
    };

    // Simple pattern cache for instant classification
    this.patternCache = new Map();
    this._initializePatternCache();
  }

  /**
   * Initialize pattern cache for common messages (zero-LLM classification)
   */
  _initializePatternCache() {
    // Exact greetings
    const greetings = ['hi', 'hello', 'hey', 'hii', 'hiii', 'helo', 'namaste', 'good morning', 'good afternoon', 'good evening'];
    greetings.forEach(g => this.patternCache.set(g, 'START'));

    // Confirmation patterns
    const confirmations = ['yes', 'ok', 'okay', 'sure', 'proceed', 'confirm', 'book', 'order', 'yes please'];
    confirmations.forEach(c => this.patternCache.set(c, 'CAPTURE_LEAD'));
  }

  /**
   * Get next Groq client (round-robin)
   */
  _getNextClient() {
    if (this.groqClients.length === 0) return null;
    const client = this.groqClients[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.groqClients.length;
    return client;
  }

  /**
   * Classify message using pattern matching (zero-token)
   */
  _classifyByPattern(message) {
    const normalized = message.toLowerCase().trim();

    // Check exact matches in cache
    if (this.patternCache.has(normalized)) {
      return this.patternCache.get(normalized);
    }

    // Image detection
    if (normalized.includes('[image]') || normalized.includes('image:')) {
      return 'PHOTOS';
    }

    // Product keyword patterns
    const patterns = {
      COASTERS: /\b(coaster|coasters)\b/i,
      DESK_ORGANIZER: /\b(desk organizer|pen holder|desk stand|pen stand|organiser)\b/i,
      WALL_TILES: /\b(wall tile|cork tile|wall panel|wall decor|tile)\b/i,
      YOGA_MAT: /\b(yoga|yoga mat|yoga block|yoga wheel)\b/i,
      LAMPSHADE: /\b(lamp|lampshade|light|pendant|wall lamp)\b/i,
      HORECA: /\b(hotel|restaurant|cafe|bar|caddy|bill folder|menu folder|trivet|horeca)\b/i,
      QUOTE_REQUEST: /\b(price|cost|quote|how much|rate|pricing|bulk|wholesale|₹|rs|rupee)\b/i
    };

    for (const [node, pattern] of Object.entries(patterns)) {
      if (pattern.test(normalized)) {
        return node;
      }
    }

    // Check for other products
    const otherProducts = /\b(diary|diaries|calendar|bag|wallet|planter|frame|tray|clock|bottle)\b/i;
    if (otherProducts.test(normalized)) {
      return 'QUOTE_REQUEST'; // Generic product inquiry
    }

    return null; // Need LLM classification
  }

  /**
   * Classify message using LLM
   */
  async _classifyWithLLM(message) {
    const client = this._getNextClient();
    if (!client) {
      throw new Error('No Groq API keys configured');
    }

    const maxRetries = this.groqClients.length;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const completion = await client.chat.completions.create({
          messages: [
            { role: 'system', content: ROUTER_PROMPT },
            { role: 'user', content: message }
          ],
          model: MODELS.GROQ_FAST, // Fast, small model for classification
          temperature: 0.1, // Low temp for consistent classification
          max_tokens: 10, // Only need node name
          top_p: 1
        });

        const response = completion.choices[0]?.message?.content?.trim().toUpperCase();

        // Validate response is a valid node
        const validNodes = [
          'START', 'COASTERS', 'DESK_ORGANIZER', 'WALL_TILES',
          'YOGA_MAT', 'LAMPSHADE', 'PHOTOS', 'QUOTE_REQUEST',
          'CAPTURE_LEAD', 'HORECA', 'FALLBACK'
        ];

        if (validNodes.includes(response)) {
          return response;
        }

        // Try to extract valid node from response
        for (const node of validNodes) {
          if (response.includes(node)) {
            return node;
          }
        }

        console.warn(`[Router] Invalid LLM response: ${response}, defaulting to FALLBACK`);
        return 'FALLBACK';

      } catch (error) {
        console.error(`[Router] Groq error (key ${this.currentKeyIndex}):`, error.message);

        if (error.status === 429) {
          // Rate limited, try next key
          this._getNextClient();
          continue;
        }

        throw error;
      }
    }

    throw new Error('All Groq keys rate limited');
  }

  /**
   * Classify incoming message
   * @param {string} message - User message
   * @param {Object} state - Current conversation state (optional)
   * @returns {Promise<string>} Node name
   */
  async classify(message, state = null) {
    this.stats.classifications++;

    // Handle empty or emoji-only messages
    if (!message || message.trim().length === 0) {
      return 'FALLBACK';
    }

    // Check if message is emoji-only
    const emojiPattern = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+$/u;
    if (emojiPattern.test(message.trim())) {
      return 'START'; // Treat emojis as greeting
    }

    try {
      // Try pattern matching first (zero-token)
      const patternResult = this._classifyByPattern(message);
      if (patternResult) {
        this.stats.cacheHits++;
        console.log(`[Router] Pattern match: "${message.slice(0, 30)}..." -> ${patternResult}`);
        return patternResult;
      }

      // Use context to help classification
      if (state) {
        // If we're in a specific product node and user says "yes" or "show me"
        if (state.current_node !== 'START' && state.current_node !== 'FALLBACK') {
          const affirmative = /^(yes|ok|sure|show|send|share|please)/i;
          if (affirmative.test(message.trim())) {
            // Stay in current node or move to next logical step
            if (['COASTERS', 'DESK_ORGANIZER', 'WALL_TILES', 'YOGA_MAT', 'LAMPSHADE', 'HORECA'].includes(state.current_node)) {
              return 'QUOTE_REQUEST';
            }
            if (state.current_node === 'QUOTE_REQUEST') {
              return 'CAPTURE_LEAD';
            }
          }
        }
      }

      // Fall back to LLM classification
      const llmResult = await this._classifyWithLLM(message);
      console.log(`[Router] LLM classify: "${message.slice(0, 30)}..." -> ${llmResult}`);
      return llmResult;

    } catch (error) {
      this.stats.errors++;
      console.error(`[Router] Classification error:`, error.message);
      return 'FALLBACK';
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return this.stats;
  }
}

module.exports = RouterAgent;
