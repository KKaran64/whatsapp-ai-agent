/**
 * Token-Optimized Bot Orchestrator
 *
 * Main entry point that wires together:
 * - Router Agent: Message classification (~80 tokens)
 * - State Manager: Zero-token MongoDB state tracking
 * - Responder Agent: Response generation (~150 tokens)
 * - Media Handler: Pre-uploaded product images
 *
 * Total token budget: ~255 tokens per message (vs 800-2000 current)
 * Token savings: 70-85%
 */

const RouterAgent = require('./router-agent');
const ResponderAgent = require('./responder-agent');
const StateManager = require('./state-manager');
const MediaHandler = require('./media-handler');

class OptimizedBot {
  constructor(config) {
    this.config = config;

    // Initialize components
    this.router = new RouterAgent(config);
    this.responder = new ResponderAgent(config);
    this.stateManager = StateManager; // Singleton
    this.mediaHandler = new MediaHandler(config);

    // Stats
    this.stats = {
      messagesProcessed: 0,
      successfulResponses: 0,
      fallbacksUsed: 0,
      errors: 0,
      averageLatency: 0,
      totalLatency: 0
    };

    this.initialized = false;
  }

  /**
   * Initialize the bot (call once on startup)
   */
  async initialize() {
    if (this.initialized) return;

    console.log('[OptimizedBot] Initializing...');

    try {
      // Pre-load product images (optional, can be lazy-loaded)
      // Commenting out for faster startup - images will be loaded on demand
      // await this.mediaHandler.preloadImages();

      this.initialized = true;
      console.log('[OptimizedBot] Initialization complete');
    } catch (error) {
      console.error('[OptimizedBot] Initialization error:', error.message);
      throw error;
    }
  }

  /**
   * Process incoming WhatsApp message
   *
   * @param {string} phoneNumber - Customer WhatsApp number
   * @param {string} message - Message content
   * @param {string} messageType - 'text' or 'image'
   * @param {string} mediaId - Media ID for images (optional)
   * @returns {Promise<Object>} { response, media, node, latency }
   */
  async processMessage(phoneNumber, message, messageType = 'text', mediaId = null) {
    const startTime = Date.now();
    this.stats.messagesProcessed++;

    try {
      // Step 1: Get current state (zero tokens)
      const state = await this.stateManager.getState(phoneNumber);

      // Step 2: Classify message -> get node (~5 tokens output)
      let node;
      if (messageType === 'image') {
        node = 'PHOTOS';
        message = mediaId ? `[IMAGE: ${message || 'no caption'}]` : message;
      } else {
        node = await this.router.classify(message, state);
      }

      console.log(`[OptimizedBot] ${phoneNumber.slice(-4)}: "${message.slice(0, 30)}..." -> ${node}`);

      // Step 3: Update state with new node (zero tokens)
      await this.stateManager.transitionNode(phoneNumber, node);

      // Step 4: Extract info from message and update state
      await this._extractAndUpdateState(phoneNumber, message, node);

      // Step 5: Get updated state and recent messages
      const updatedState = await this.stateManager.getState(phoneNumber);
      const recentMessages = await this.stateManager.getRecentMessages(phoneNumber);

      // Step 6: Generate response (~50 tokens output)
      const { response, media } = await this.responder.generateResponse(
        node,
        updatedState,
        message,
        recentMessages
      );

      // Step 7: Store messages in history (zero tokens)
      await this.stateManager.addMessage(phoneNumber, 'user', message);
      await this.stateManager.addMessage(phoneNumber, 'assistant', response);

      // Step 8: Handle media if triggered
      if (media) {
        const alreadySent = await this.stateManager.wasImageSent(phoneNumber, media);
        if (!alreadySent) {
          await this.mediaHandler.handleMediaTrigger(phoneNumber, media);
          await this.stateManager.markImageSent(phoneNumber, media);
        }
      }

      // Calculate latency
      const latency = Date.now() - startTime;
      this.stats.totalLatency += latency;
      this.stats.averageLatency = this.stats.totalLatency / this.stats.messagesProcessed;
      this.stats.successfulResponses++;

      console.log(`[OptimizedBot] Response generated in ${latency}ms`);

      return {
        response,
        media,
        node,
        latency,
        state: {
          leadScore: updatedState.lead_score,
          productInterest: updatedState.product_interest,
          qualifiers: updatedState.qualifiers
        }
      };

    } catch (error) {
      this.stats.errors++;
      console.error('[OptimizedBot] Error:', error.message);

      // Return fallback response
      this.stats.fallbacksUsed++;
      return {
        response: "I'm here to help with cork products. What are you looking for?",
        media: null,
        node: 'FALLBACK',
        latency: Date.now() - startTime,
        error: error.message
      };
    }
  }

  /**
   * Extract information from message and update state
   */
  async _extractAndUpdateState(phoneNumber, message, node) {
    const msg = message.toLowerCase();

    // Extract product interest based on node
    const nodeToProduct = {
      COASTERS: 'coasters',
      DESK_ORGANIZER: 'desk organizer',
      WALL_TILES: 'wall tiles',
      YOGA_MAT: 'yoga mat',
      LAMPSHADE: 'lampshade'
    };

    if (nodeToProduct[node]) {
      await this.stateManager.addProductInterest(phoneNumber, nodeToProduct[node]);
    }

    // Extract quantity
    const quantityMatch = msg.match(/(\d+)\s*(?:pcs?|pieces?|nos?|units?|qty)/i);
    if (quantityMatch) {
      await this.stateManager.updateState(phoneNumber, {
        quantity: parseInt(quantityMatch[1])
      });
    }

    // Extract customer type
    if (/\b(corporate|company|office|business)\b/i.test(msg)) {
      await this.stateManager.updateState(phoneNumber, { product_type: 'corporate' });
      await this.stateManager.updateQualifiers(phoneNumber, { why: 'corporate' });
    } else if (/\b(hotel|restaurant|cafe|bar|horeca)\b/i.test(msg)) {
      await this.stateManager.updateState(phoneNumber, { product_type: 'horeca' });
      await this.stateManager.updateQualifiers(phoneNumber, { why: 'horeca' });
    } else if (/\b(personal|home|myself|gift)\b/i.test(msg)) {
      await this.stateManager.updateState(phoneNumber, { product_type: 'retail' });
      await this.stateManager.updateQualifiers(phoneNumber, { why: 'personal' });
    }

    // Extract other qualifiers
    if (/\b(client|clients|customer|customers)\b/i.test(msg)) {
      await this.stateManager.updateQualifiers(phoneNumber, { who: 'clients' });
    } else if (/\b(employee|employees|staff|team)\b/i.test(msg)) {
      await this.stateManager.updateQualifiers(phoneNumber, { who: 'employees' });
    }

    // Timeline
    if (/\b(urgent|asap|today|tomorrow)\b/i.test(msg)) {
      await this.stateManager.updateQualifiers(phoneNumber, { when: 'urgent' });
    } else if (/\b(next week|this week)\b/i.test(msg)) {
      await this.stateManager.updateQualifiers(phoneNumber, { when: 'this week' });
    } else if (/\b(next month|year.?end|quarter)\b/i.test(msg)) {
      await this.stateManager.updateQualifiers(phoneNumber, { when: 'scheduled' });
    }

    // Branding
    if (/\b(logo|brand|custom|personalize)\b/i.test(msg)) {
      if (/\b(no logo|without logo|plain|no brand)\b/i.test(msg)) {
        await this.stateManager.updateQualifiers(phoneNumber, { branding: 'no' });
      } else if (/\b(multi.?color|full.?color|colorful)\b/i.test(msg)) {
        await this.stateManager.updateQualifiers(phoneNumber, { branding: 'multi-color' });
      } else {
        await this.stateManager.updateQualifiers(phoneNumber, { branding: 'single-color' });
      }
    }

    // Extract products mentioned
    const products = {
      diary: /\b(diary|diaries)\b/i,
      calendar: /\b(calendar|calender)\b/i,
      bag: /\b(bag|bags|laptop bag)\b/i,
      wallet: /\b(wallet|wallets)\b/i,
      planter: /\b(planter|planters)\b/i,
      tray: /\b(tray|trays)\b/i,
      frame: /\b(frame|frames|photo frame)\b/i,
      clock: /\b(clock|clocks|wall clock)\b/i
    };

    for (const [product, pattern] of Object.entries(products)) {
      if (pattern.test(msg)) {
        await this.stateManager.addProductInterest(phoneNumber, product);
      }
    }
  }

  /**
   * Reset conversation for a phone number
   */
  async resetConversation(phoneNumber) {
    await this.stateManager.resetState(phoneNumber);
    console.log(`[OptimizedBot] Conversation reset for ${phoneNumber.slice(-4)}`);
  }

  /**
   * Get conversation state
   */
  async getState(phoneNumber) {
    return this.stateManager.getState(phoneNumber);
  }

  /**
   * Send WhatsApp message (wrapper for external use)
   */
  async sendMessage(phoneNumber, message) {
    // This will be injected by server.js
    if (this._sendMessageFn) {
      return this._sendMessageFn(phoneNumber, message);
    }
    console.warn('[OptimizedBot] sendMessage function not set');
    return false;
  }

  /**
   * Set the send message function (called by server.js)
   */
  setSendMessageFunction(fn) {
    this._sendMessageFn = fn;
  }

  /**
   * Get aggregated statistics
   */
  getStats() {
    return {
      bot: this.stats,
      router: this.router.getStats(),
      responder: this.responder.getStats(),
      stateManager: this.stateManager.getStats(),
      mediaHandler: this.mediaHandler.getStats()
    };
  }

  /**
   * Health check
   */
  isHealthy() {
    return this.initialized && this.stats.errors < this.stats.messagesProcessed * 0.1;
  }
}

// Export class and singleton factory
let instance = null;

module.exports = {
  OptimizedBot,

  /**
   * Get or create singleton instance
   */
  getInstance(config) {
    if (!instance && config) {
      instance = new OptimizedBot(config);
    }
    return instance;
  },

  /**
   * Create fresh instance (for testing)
   */
  createInstance(config) {
    return new OptimizedBot(config);
  }
};
