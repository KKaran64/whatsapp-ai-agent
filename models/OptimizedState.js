/**
 * OptimizedState Model
 *
 * Lightweight state tracking for the 3-agent token-optimized bot.
 * Stores conversation state without full message history to reduce token usage.
 *
 * Part of the token-optimized architecture that reduces usage from 800-2000 tokens
 * to 150-250 tokens per message.
 */

const mongoose = require('mongoose');

// Minimal message schema - only last 3 messages for context
const compactMessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },
  content: {
    type: String,
    required: true,
    maxlength: 500 // Limit message length for token efficiency
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const optimizedStateSchema = new mongoose.Schema({
  // Primary key - WhatsApp number
  customer_phone: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Customer info (extracted from conversation)
  customer_name: {
    type: String,
    default: null
  },

  // Products discussed in this session
  product_interest: {
    type: [String],
    default: []
  },

  // Quantity requested (if mentioned)
  quantity: {
    type: Number,
    default: null
  },

  // Customer type: retail, corporate, horeca
  product_type: {
    type: String,
    enum: ['retail', 'corporate', 'horeca', null],
    default: null
  },

  // Pricing-slab customer type from resolveIntent() — a DIFFERENT axis from
  // product_type above (which is a use-case: retail/corporate/horeca).
  // This is end_consumer vs. reseller, the axis quote-engine.js prices by.
  // Never map one onto the other.
  pricing_customer_type: {
    type: String,
    enum: ['end_consumer', 'reseller', null],
    default: null
  },

  // Current conversation node (from router)
  current_node: {
    type: String,
    enum: [
      'START',
      'COASTERS',
      'DESK_ORGANIZER',
      'WALL_TILES',
      'YOGA_MAT',
      'LAMPSHADE',
      'PHOTOS',
      'QUOTE_REQUEST',
      'CAPTURE_LEAD',
      'HORECA',
      'FALLBACK'
    ],
    default: 'START'
  },

  // Previous node for context
  previous_node: {
    type: String,
    default: null
  },

  // Lead qualification score (0-100)
  lead_score: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

  // Qualification flags
  qualifiers: {
    why: { type: String, default: null },      // corporate/personal/event
    who: { type: String, default: null },      // executives/clients/employees
    when: { type: String, default: null },     // timeline
    branding: { type: String, default: null }  // yes/no/single-color/multi-color
  },

  // Last interaction timestamp (indexed via TTL below)
  last_interaction: {
    type: Date,
    default: Date.now
  },

  // Compact conversation history (last 50 messages — matches the main
  // bot's context window; deriveStateAsync needs this depth to still see
  // evidence like an earlier quote or a payment confirmation).
  conversation_history: {
    type: [compactMessageSchema],
    default: [],
    validate: {
      validator: function(arr) {
        return arr.length <= 50;
      },
      message: 'Conversation history limited to 50 messages'
    }
  },

  // Session metadata
  session_start: {
    type: Date,
    default: Date.now
  },

  // Images sent in this session (to avoid duplicates)
  sent_images: {
    type: [String],
    default: []
  }
}, {
  timestamps: true,
  collection: 'optimized_states'
});

// TTL Index: Auto-expire stale sessions after 24 hours
optimizedStateSchema.index(
  { last_interaction: 1 },
  { expireAfterSeconds: 86400 } // 24 hours
);

// Compound index for efficient queries
optimizedStateSchema.index({ customer_phone: 1, last_interaction: -1 });

// Pre-save hook to update last_interaction
optimizedStateSchema.pre('save', function(next) {
  this.last_interaction = new Date();
  next();
});

// Method to add a message (maintains 50-message limit)
optimizedStateSchema.methods.addMessage = function(role, content) {
  // Truncate content if too long
  const truncatedContent = content.length > 500
    ? content.substring(0, 497) + '...'
    : content;

  this.conversation_history.push({
    role,
    content: truncatedContent,
    timestamp: new Date()
  });

  // Keep only last 50 messages
  if (this.conversation_history.length > 50) {
    this.conversation_history = this.conversation_history.slice(-50);
  }

  return this;
};

// Method to transition node
optimizedStateSchema.methods.transitionNode = function(newNode) {
  this.previous_node = this.current_node;
  this.current_node = newNode;
  return this;
};

// Method to add product interest
optimizedStateSchema.methods.addProduct = function(product) {
  const normalizedProduct = product.toLowerCase().trim();
  if (!this.product_interest.includes(normalizedProduct)) {
    this.product_interest.push(normalizedProduct);
  }
  return this;
};

// Method to update lead score
optimizedStateSchema.methods.updateLeadScore = function() {
  let score = 0;

  // +10 for each qualifier filled
  if (this.qualifiers.why) score += 10;
  if (this.qualifiers.who) score += 10;
  if (this.qualifiers.when) score += 10;
  if (this.qualifiers.branding) score += 10;

  // +15 for product interest
  if (this.product_interest.length > 0) score += 15;

  // +20 for quantity specified
  if (this.quantity && this.quantity > 0) score += 20;

  // +15 for customer type identified
  if (this.product_type) score += 15;

  // +10 for customer name
  if (this.customer_name) score += 10;

  this.lead_score = Math.min(score, 100);
  return this;
};

// Method to get context string for AI (token-efficient)
optimizedStateSchema.methods.getContextString = function() {
  const parts = [];

  if (this.customer_name) parts.push(`Name: ${this.customer_name}`);
  if (this.product_interest.length > 0) parts.push(`Products: ${this.product_interest.join(', ')}`);
  if (this.quantity) parts.push(`Qty: ${this.quantity}`);
  if (this.product_type) parts.push(`Type: ${this.product_type}`);
  if (this.qualifiers.why) parts.push(`Use: ${this.qualifiers.why}`);
  if (this.qualifiers.who) parts.push(`For: ${this.qualifiers.who}`);
  if (this.qualifiers.when) parts.push(`When: ${this.qualifiers.when}`);
  if (this.qualifiers.branding) parts.push(`Logo: ${this.qualifiers.branding}`);

  return parts.join(' | ');
};

// Static method to get or create state
optimizedStateSchema.statics.getOrCreate = async function(phone) {
  let state = await this.findOne({ customer_phone: phone });

  if (!state) {
    state = new this({
      customer_phone: phone,
      current_node: 'START',
      session_start: new Date()
    });
    await state.save();
  }

  return state;
};

// Static method to reset state
optimizedStateSchema.statics.resetState = async function(phone) {
  return this.findOneAndUpdate(
    { customer_phone: phone },
    {
      $set: {
        current_node: 'START',
        previous_node: null,
        product_interest: [],
        quantity: null,
        product_type: null,
        lead_score: 0,
        qualifiers: {
          why: null,
          who: null,
          when: null,
          branding: null
        },
        conversation_history: [],
        sent_images: [],
        session_start: new Date(),
        last_interaction: new Date()
      }
    },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('OptimizedState', optimizedStateSchema);
