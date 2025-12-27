const mongoose = require('mongoose');
const { encryptionPlugin, encrypt, decrypt } = require('../mongodb-encryption');

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
  customerPhone: {
    type: String,
    required: true,
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
    quantity: Number
  }
});

// SECURITY FIX: Encrypt message content before saving (GDPR/CCPA compliance)
conversationSchema.pre('save', function(next) {
  // Encrypt message content for all modified messages
  if (this.isModified('messages')) {
    this.messages.forEach((msg) => {
      // Only encrypt if not already encrypted (check for encryption format)
      if (msg.content && !msg.content.includes(':')) {
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

// Apply field-level encryption to PII (GDPR/CCPA compliance)
// Encrypts customer phone number AND message content (both encrypted for GDPR)
conversationSchema.plugin(encryptionPlugin, {
  fields: ['customerPhone']
});

module.exports = mongoose.model('Conversation', conversationSchema);
