const mongoose = require('mongoose');
const { encrypt, decrypt, isEncrypted, encryptionPlugin, blindIndexPlugin, phoneBlindIndex } = require('../mongodb-encryption');

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['customer', 'agent'],
    required: true
  },
  content: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  messageId: String,
  status: {
    type: String,
    enum: ['sent', 'delivered', 'read', 'failed'],
    default: 'sent'
  }
});

const conversationSchema = new mongoose.Schema({
  // Encrypted at rest — query via phoneHash / Conversation.phoneFilter(), never
  // by this field's plaintext.
  customerPhone: {
    type: String,
    required: true
  },
  // Deterministic blind index of customerPhone — the lookup key.
  phoneHash: {
    type: String,
    index: true
  },
  messages: [messageSchema],
  status: {
    type: String,
    enum: ['active', 'closed', 'archived'],
    default: 'active'
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  tags: [String],
  metadata: {
    productInterest: [String],
    budget: String,
    timeline: String,
    quantity: Number,
    // v59 — RULE G escalation tracking
    needsHumanFollowup: { type: Boolean, default: false, index: true },
    escalations: [{
      timestamp: { type: Date, default: Date.now },
      customerMessage: String,
      botResponse: String,
      notifiedAt: Date,
      resolved: { type: Boolean, default: false }
    }]
  },
  // RAG fields
  outcome: {
    type: String,
    enum: ['in_progress', 'sale', 'no_sale', 'abandoned'],
    default: 'in_progress',
    index: true
  },
  outcomeAmount: { type: Number, default: 0 },
  outcomeDetectedAt: Date,
  embedded: { type: Boolean, default: false, index: true },
  embeddingIds: { type: [String], default: [] },
  embeddingError: String,
});

// SECURITY FIX: Encrypt message content before saving (GDPR/CCPA compliance)
conversationSchema.pre('save', function(next) {
  // Encrypt message content for all modified messages
  if (this.isModified('messages')) {
    this.messages.forEach((msg) => {
      // Only encrypt if not already encrypted (strict iv:tag:ciphertext check —
      // the old `includes(':')` check silently skipped any message containing
      // a colon, leaving most bot replies stored in plaintext)
      if (msg.content && !isEncrypted(msg.content)) {
        try {
          msg.content = encrypt(msg.content);
        } catch (err) {
          console.error('❌ Failed to encrypt message content:', err.message);
        }
      }
    });
  }
  next();
});

// Update lastMessageAt on save
conversationSchema.pre('save', function(next) {
  if (this.messages.length > 0) {
    this.lastMessageAt = this.messages[this.messages.length - 1].timestamp;
  }
  next();
});

// Method to add a message
conversationSchema.methods.addMessage = function(role, content, messageId = null) {
  this.messages.push({
    role,
    content,
    messageId,
    timestamp: new Date()
  });
  return this.save();
};

// Method to get recent messages for context
conversationSchema.methods.getRecentMessages = function(limit = 10) {
  return this.messages.slice(-limit);
};

// SECURITY FIX: Decrypt message content after reading (GDPR/CCPA compliance)
conversationSchema.post('find', function(docs) {
  if (!Array.isArray(docs)) return;

  docs.forEach(doc => {
    if (doc.messages && Array.isArray(doc.messages)) {
      doc.messages.forEach(msg => {
        if (msg.content) {
          try {
            msg.content = decrypt(msg.content);
          } catch (err) {
            console.error('❌ Failed to decrypt message content:', err.message);
          }
        }
      });
    }
  });
});

conversationSchema.post('findOne', function(doc) {
  if (!doc) return;

  if (doc.messages && Array.isArray(doc.messages)) {
    doc.messages.forEach(msg => {
      if (msg.content) {
        try {
          msg.content = decrypt(msg.content);
        } catch (err) {
          console.error('❌ Failed to decrypt message content:', err.message);
        }
      }
    });
  }
});

// Look up a conversation by phone without querying the encrypted field.
// Spread into any query; combine with other filters, e.g.
//   Conversation.findOne({ ...Conversation.phoneFilter(phone), status: 'active' })
// $or covers the migration window (phoneHash for new docs, plaintext for
// un-backfilled legacy docs). See Customer.phoneFilter for details.
conversationSchema.statics.phoneFilter = function (phone) {
  return { $or: [{ phoneHash: phoneBlindIndex(phone) }, { customerPhone: phone }] };
};

// Blind index BEFORE encryption so it hashes the plaintext customerPhone.
conversationSchema.plugin(blindIndexPlugin, { sourceField: 'customerPhone', hashField: 'phoneHash' });

// Encrypt customerPhone at rest (message content is encrypted via the explicit
// pre/post hooks above; phoneHash provides deterministic lookup).
conversationSchema.plugin(encryptionPlugin, { fields: ['customerPhone'] });

module.exports = mongoose.model('Conversation', conversationSchema);
