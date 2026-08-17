/**
 * Responder Agent for Token-Optimized Bot
 *
 * Generates contextual responses under 30 words based on:
 * - Current node
 * - Conversation state
 * - User message
 *
 * Token budget: ~150-200 tokens total
 * - Input: ~120 tokens (node + state + templates)
 * - Output: ~50 tokens (30 words max)
 */

const Groq = require('groq-sdk');

// Node-specific response templates and prompts
const NODE_TEMPLATES = {
  START: {
    greeting: "Welcome to 9 Cork! What brings you here - corporate gifting or personal use?",
    prompt: "Greet warmly, ask use case (corporate/personal/HORECA). Max 25 words."
  },

  COASTERS: {
    info: "Cork coasters: Square, Hexagon, Heart, Leaf shapes. Sets of 4 with case available.",
    prompt: "Answer about coasters. Ask quantity if not mentioned. Max 25 words. If asked for images say 'Sure!' [SEND_MEDIA: coasters]"
  },

  DESK_ORGANIZER: {
    info: "Desk organizers: Small/Medium/Large. Pen holders, iPad stands available.",
    prompt: "Answer about desk organizers. Ask size preference. Max 25 words. [SEND_MEDIA: desk_organizer]"
  },

  WALL_TILES: {
    info: "Cork wall tiles: Various patterns for acoustic and aesthetic purposes.",
    prompt: "Answer about wall tiles. Ask room size or quantity. Max 25 words. [SEND_MEDIA: wall_tiles]"
  },

  YOGA_MAT: {
    info: "Cork yoga products: Mats, blocks (set of 2), wheels. Eco-friendly natural cork.",
    prompt: "Answer about yoga products. Ask which item interests them. Max 25 words. [SEND_MEDIA: yoga_mat]"
  },

  LAMPSHADE: {
    info: "Cork lights: Table lamps, hanging pendants, wall lamps, night lamps. Premium finish.",
    prompt: "Answer about lamps. Ask style preference (table/pendant/wall). Max 25 words. [SEND_MEDIA: lampshade]"
  },

  PHOTOS: {
    prompt: "Customer sent image. Identify product, confirm availability. Ask if they want similar. Max 25 words."
  },

  QUOTE_REQUEST: {
    prompt: "Customer asking about price. Check qualifiers needed: WHY/WHO/WHEN/BRANDING. Ask missing qualifier. Never quote price without quantity. Max 30 words."
  },

  CAPTURE_LEAD: {
    prompt: "Customer ready to order. Ask for company name OR GST number. One question at a time. Max 25 words."
  },

  HORECA: {
    info: "HORECA products: Bar caddies, bill folders, menu folders, trivets, cork lights.",
    prompt: "Answer about HORECA products. Ask about venue type/quantity. Max 25 words. [SEND_MEDIA: horeca_catalog]"
  },

  FALLBACK: {
    prompt: "Unclear message. Clarify politely. Ask what they're looking for. Max 25 words."
  }
};

// Compact system prompt (~100 tokens)
const BASE_PROMPT = `You are Sita, 9 Cork sales agent. WhatsApp chat style.

RULES:
1. Max 30 words per response
2. Never ask for email (they're on WhatsApp!)
3. Never quote price without quantity
4. One question at a time
5. If customer asks for images, include [SEND_MEDIA: product] at end

Qualifiers needed for pricing: WHY(use), WHO(recipients), WHEN(timeline), BRANDING(logo?)

Current context:`;

class ResponderAgent {
  constructor(config) {
    // Initialize Groq clients
    this.groqKeys = [];
    if (config.GROQ_API_KEY) this.groqKeys.push(config.GROQ_API_KEY);
    if (config.GROQ_API_KEY_2) this.groqKeys.push(config.GROQ_API_KEY_2);
    if (config.GROQ_API_KEY_3) this.groqKeys.push(config.GROQ_API_KEY_3);
    if (config.GROQ_API_KEY_4) this.groqKeys.push(config.GROQ_API_KEY_4);

    this.groqClients = this.groqKeys.map(key => new Groq({ apiKey: key }));
    this.currentKeyIndex = 0;

    this.stats = {
      responses: 0,
      templateHits: 0,
      llmCalls: 0,
      errors: 0,
      mediaTriggered: 0
    };
  }

  /**
   * Get next Groq client
   */
  _getNextClient() {
    if (this.groqClients.length === 0) return null;
    const client = this.groqClients[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.groqClients.length;
    return client;
  }

  /**
   * Build context string from state
   */
  _buildContext(state) {
    const parts = [];

    parts.push(`Node: ${state.current_node}`);

    if (state.product_interest?.length > 0) {
      parts.push(`Products: ${state.product_interest.join(', ')}`);
    }
    if (state.quantity) parts.push(`Qty: ${state.quantity}`);
    if (state.product_type) parts.push(`Type: ${state.product_type}`);

    // Add qualifier status
    const missing = [];
    if (!state.qualifiers?.why) missing.push('WHY');
    if (!state.qualifiers?.who) missing.push('WHO');
    if (!state.qualifiers?.when) missing.push('WHEN');
    if (!state.qualifiers?.branding) missing.push('BRANDING');

    if (missing.length > 0 && missing.length < 4) {
      parts.push(`Need: ${missing.join(', ')}`);
    }

    return parts.join(' | ');
  }

  /**
   * Check for simple response patterns (template match)
   */
  _getTemplateResponse(node, message) {
    const msg = message.toLowerCase().trim();

    // Greetings
    if (node === 'START' && /^(hi|hello|hey|hii+)$/i.test(msg)) {
      this.stats.templateHits++;
      return NODE_TEMPLATES.START.greeting;
    }

    // "Show me images" / "send photos"
    if (/\b(show|send|share)\s*(me)?\s*(image|photo|pic)/i.test(msg)) {
      const productMap = {
        COASTERS: 'coasters',
        DESK_ORGANIZER: 'desk_organizer',
        WALL_TILES: 'wall_tiles',
        YOGA_MAT: 'yoga_mat',
        LAMPSHADE: 'lampshade',
        HORECA: 'horeca_catalog'
      };

      if (productMap[node]) {
        this.stats.templateHits++;
        return `Sure! [SEND_MEDIA: ${productMap[node]}]`;
      }
    }

    return null;
  }

  /**
   * Generate response using LLM
   */
  async _generateWithLLM(node, state, message, recentMessages, verifiedQuote = null) {
    const client = this._getNextClient();
    if (!client) {
      throw new Error('No Groq API keys configured');
    }

    // Build compact prompt
    const template = NODE_TEMPLATES[node] || NODE_TEMPLATES.FALLBACK;
    const context = this._buildContext(state);

    // Compact verified-quote injection — the LLM's job becomes "present this
    // number conversationally", not "compute a price". Kept to one line to
    // preserve the compact-prompt token budget (mirrors server.js's
    // [VERIFIED QUOTE] block, trimmed for optimized-bot's ~100-150 token design).
    let quoteBlock = '';
    if (verifiedQuote && verifiedQuote.found) {
      const { formatQuoteForCustomer } = require('../pricing/quote-engine');
      quoteBlock = `\n[VERIFIED QUOTE — present this exact figure, do not compute your own]: ${formatQuoteForCustomer(verifiedQuote)}`;
    }

    // Build conversation context (last 2-3 messages)
    let conversationContext = '';
    if (recentMessages && recentMessages.length > 0) {
      conversationContext = recentMessages
        .slice(-2)
        .map(m => `${m.role}: ${m.content.slice(0, 100)}`)
        .join('\n');
    }

    const systemPrompt = `${BASE_PROMPT}
${context}${quoteBlock}
${template.info ? `\nProduct info: ${template.info}` : ''}
${template.prompt}`;

    const userPrompt = conversationContext
      ? `Previous:\n${conversationContext}\n\nCustomer: ${message}`
      : `Customer: ${message}`;

    const maxRetries = this.groqClients.length;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.stats.llmCalls++;

        const completion = await client.chat.completions.create({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          model: 'llama-3.3-70b-versatile',
          temperature: 0.4,
          max_tokens: 80, // ~30 words max
          top_p: 1
        });

        let response = completion.choices[0]?.message?.content?.trim() || "How can I help you?";

        // Clean up response
        response = this._cleanResponse(response);

        return response;

      } catch (error) {
        console.error(`[Responder] Groq error (key ${this.currentKeyIndex}):`, error.message);

        if (error.status === 429) {
          this._getNextClient();
          continue;
        }

        throw error;
      }
    }

    throw new Error('All Groq keys rate limited');
  }

  /**
   * Clean and validate response
   */
  _cleanResponse(response) {
    // Remove any system-like prefixes
    response = response
      .replace(/^(Assistant:|Sita:|Response:|AI:)/i, '')
      .trim();

    // Ensure response doesn't mention "email"
    if (/\b(email|e-mail)\b/i.test(response)) {
      response = response.replace(/share (your )?email/gi, 'message us');
    }

    // Ensure no "database" mentions
    response = response
      .replace(/database price/gi, 'price')
      .replace(/according to (our )?database/gi, '');

    // Extract media trigger if present
    const mediaMatch = response.match(/\[SEND_MEDIA:\s*([^\]]+)\]/i);
    if (mediaMatch) {
      this.stats.mediaTriggered++;
    }

    return response;
  }

  /**
   * Extract media trigger from response
   */
  extractMediaTrigger(response) {
    const match = response.match(/\[SEND_MEDIA:\s*([^\]]+)\]/i);
    if (match) {
      const product = match[1].trim().toLowerCase();
      // Return cleaned response and media product
      return {
        response: response.replace(/\[SEND_MEDIA:\s*[^\]]+\]/gi, '').trim(),
        media: product
      };
    }
    return { response, media: null };
  }

  /**
   * Generate response
   * @param {string} node - Current conversation node
   * @param {Object} state - Conversation state
   * @param {string} message - User message
   * @param {Array} recentMessages - Last 2-3 messages
   * @returns {Promise<Object>} { response, media }
   */
  async generateResponse(node, state, message, recentMessages = [], verifiedQuote = null) {
    this.stats.responses++;

    try {
      // Try template response first
      const templateResponse = this._getTemplateResponse(node, message);
      if (templateResponse) {
        return this.extractMediaTrigger(templateResponse);
      }

      // Generate with LLM
      const llmResponse = await this._generateWithLLM(node, state, message, recentMessages, verifiedQuote);
      return this.extractMediaTrigger(llmResponse);

    } catch (error) {
      this.stats.errors++;
      console.error(`[Responder] Error:`, error.message);

      // Fallback response
      return {
        response: "I'm here to help with cork products. What are you looking for?",
        media: null
      };
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return this.stats;
  }
}

module.exports = ResponderAgent;
