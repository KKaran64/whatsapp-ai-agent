/**
 * State Manager for Token-Optimized Bot
 *
 * Zero-LLM-token state tracking using MongoDB.
 * All operations are atomic to prevent race conditions.
 *
 * Functions:
 * - getState(phone) - Retrieve or create state
 * - updateState(phone, updates) - Atomic updates
 * - addMessage(phone, role, content) - Maintain 3-message history
 * - resetState(phone) - Clear for new conversation
 */

const OptimizedState = require('../models/OptimizedState');

// In-memory cache for faster lookups (optional, reduces DB calls)
const stateCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class StateManager {
  constructor() {
    this.stats = {
      gets: 0,
      creates: 0,
      updates: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0
    };
  }

  /**
   * Get or create state for a phone number
   * @param {string} phone - WhatsApp phone number
   * @returns {Promise<Object>} State document
   */
  async getState(phone) {
    this.stats.gets++;

    try {
      // Check cache first
      const cached = this._getFromCache(phone);
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      this.stats.cacheMisses++;

      // Get from database
      let state = await OptimizedState.findOne({ customer_phone: phone });

      if (!state) {
        // Create new state
        this.stats.creates++;
        state = new OptimizedState({
          customer_phone: phone,
          current_node: 'START',
          session_start: new Date()
        });
        await state.save();
        console.log(`[StateManager] Created new state for ${phone.slice(-4)}`);
      }

      // Update cache
      this._setCache(phone, state);

      return state;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error getting state for ${phone}:`, error.message);
      throw error;
    }
  }

  /**
   * Update state with atomic operations
   * @param {string} phone - WhatsApp phone number
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated state
   */
  async updateState(phone, updates) {
    this.stats.updates++;

    try {
      // Build atomic update object
      const updateOps = {
        $set: {
          ...updates,
          last_interaction: new Date()
        }
      };

      // Handle array operations separately
      if (updates.addProduct) {
        delete updateOps.$set.addProduct;
        updateOps.$addToSet = {
          product_interest: updates.addProduct
        };
      }

      if (updates.addSentImage) {
        delete updateOps.$set.addSentImage;
        updateOps.$addToSet = updateOps.$addToSet || {};
        updateOps.$addToSet.sent_images = updates.addSentImage;
      }

      const state = await OptimizedState.findOneAndUpdate(
        { customer_phone: phone },
        updateOps,
        { new: true, upsert: true }
      );

      // Update cache
      this._setCache(phone, state);

      console.log(`[StateManager] Updated state for ${phone.slice(-4)}: node=${state.current_node}`);
      return state;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error updating state for ${phone}:`, error.message);
      throw error;
    }
  }

  /**
   * Transition to a new node
   * @param {string} phone - WhatsApp phone number
   * @param {string} newNode - New conversation node
   * @returns {Promise<Object>} Updated state
   */
  async transitionNode(phone, newNode) {
    try {
      const state = await this.getState(phone);

      const updatedState = await OptimizedState.findOneAndUpdate(
        { customer_phone: phone },
        {
          $set: {
            previous_node: state.current_node,
            current_node: newNode,
            last_interaction: new Date()
          }
        },
        { new: true }
      );

      this._setCache(phone, updatedState);

      console.log(`[StateManager] Node transition: ${state.current_node} -> ${newNode}`);
      return updatedState;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error transitioning node:`, error.message);
      throw error;
    }
  }

  /**
   * Add message to conversation history (maintains 3-message limit)
   * @param {string} phone - WhatsApp phone number
   * @param {string} role - 'user' or 'assistant'
   * @param {string} content - Message content
   * @returns {Promise<Object>} Updated state
   */
  async addMessage(phone, role, content) {
    try {
      // Truncate content if too long
      const truncatedContent = content.length > 500
        ? content.substring(0, 497) + '...'
        : content;

      const newMessage = {
        role,
        content: truncatedContent,
        timestamp: new Date()
      };

      // Use aggregation pipeline for atomic push with limit
      const state = await OptimizedState.findOneAndUpdate(
        { customer_phone: phone },
        [
          {
            $set: {
              conversation_history: {
                $slice: [
                  { $concatArrays: ['$conversation_history', [newMessage]] },
                  -3  // Keep only last 3
                ]
              },
              last_interaction: new Date()
            }
          }
        ],
        { new: true, upsert: true }
      );

      this._setCache(phone, state);

      return state;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error adding message:`, error.message);
      throw error;
    }
  }

  /**
   * Reset state for new conversation
   * @param {string} phone - WhatsApp phone number
   * @returns {Promise<Object>} Reset state
   */
  async resetState(phone) {
    try {
      const state = await OptimizedState.resetState(phone);

      // Clear cache
      this._clearCache(phone);

      console.log(`[StateManager] Reset state for ${phone.slice(-4)}`);
      return state;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error resetting state:`, error.message);
      throw error;
    }
  }

  /**
   * Update qualification info
   * @param {string} phone - WhatsApp phone number
   * @param {Object} qualifiers - Qualification data (why, who, when, branding)
   * @returns {Promise<Object>} Updated state
   */
  async updateQualifiers(phone, qualifiers) {
    try {
      const updateObj = {};
      if (qualifiers.why) updateObj['qualifiers.why'] = qualifiers.why;
      if (qualifiers.who) updateObj['qualifiers.who'] = qualifiers.who;
      if (qualifiers.when) updateObj['qualifiers.when'] = qualifiers.when;
      if (qualifiers.branding) updateObj['qualifiers.branding'] = qualifiers.branding;

      const state = await OptimizedState.findOneAndUpdate(
        { customer_phone: phone },
        { $set: { ...updateObj, last_interaction: new Date() } },
        { new: true }
      );

      // Recalculate lead score
      if (state) {
        state.updateLeadScore();
        await state.save();
        this._setCache(phone, state);
      }

      return state;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error updating qualifiers:`, error.message);
      throw error;
    }
  }

  /**
   * Add product interest
   * @param {string} phone - WhatsApp phone number
   * @param {string} product - Product name
   * @returns {Promise<Object>} Updated state
   */
  async addProductInterest(phone, product) {
    try {
      const normalizedProduct = product.toLowerCase().trim();

      const state = await OptimizedState.findOneAndUpdate(
        { customer_phone: phone },
        {
          $addToSet: { product_interest: normalizedProduct },
          $set: { last_interaction: new Date() }
        },
        { new: true, upsert: true }
      );

      this._setCache(phone, state);

      console.log(`[StateManager] Added product interest: ${normalizedProduct}`);
      return state;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error adding product:`, error.message);
      throw error;
    }
  }

  /**
   * Mark image as sent (to avoid duplicates)
   * @param {string} phone - WhatsApp phone number
   * @param {string} imageId - Image identifier
   * @returns {Promise<Object>} Updated state
   */
  async markImageSent(phone, imageId) {
    try {
      const state = await OptimizedState.findOneAndUpdate(
        { customer_phone: phone },
        {
          $addToSet: { sent_images: imageId },
          $set: { last_interaction: new Date() }
        },
        { new: true }
      );

      this._setCache(phone, state);
      return state;
    } catch (error) {
      this.stats.errors++;
      console.error(`[StateManager] Error marking image sent:`, error.message);
      throw error;
    }
  }

  /**
   * Check if image was already sent
   * @param {string} phone - WhatsApp phone number
   * @param {string} imageId - Image identifier
   * @returns {Promise<boolean>} True if already sent
   */
  async wasImageSent(phone, imageId) {
    try {
      const state = await this.getState(phone);
      return state.sent_images && state.sent_images.includes(imageId);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get context string for AI (token-efficient)
   * @param {string} phone - WhatsApp phone number
   * @returns {Promise<string>} Context string
   */
  async getContextString(phone) {
    try {
      const state = await this.getState(phone);
      return state.getContextString();
    } catch (error) {
      return '';
    }
  }

  /**
   * Get recent messages for context
   * @param {string} phone - WhatsApp phone number
   * @returns {Promise<Array>} Last 3 messages
   */
  async getRecentMessages(phone) {
    try {
      const state = await this.getState(phone);
      return state.conversation_history || [];
    } catch (error) {
      return [];
    }
  }

  // Cache helpers
  _getFromCache(phone) {
    const cached = stateCache.get(phone);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.state;
    }
    stateCache.delete(phone);
    return null;
  }

  _setCache(phone, state) {
    // Limit cache size
    if (stateCache.size > 1000) {
      const firstKey = stateCache.keys().next().value;
      stateCache.delete(firstKey);
    }

    stateCache.set(phone, {
      state,
      timestamp: Date.now()
    });
  }

  _clearCache(phone) {
    stateCache.delete(phone);
  }

  /**
   * Get statistics
   * @returns {Object} Stats object
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: stateCache.size
    };
  }
}

// Export singleton instance
module.exports = new StateManager();
