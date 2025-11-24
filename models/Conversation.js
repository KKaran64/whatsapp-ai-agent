const mongoose = require('mongoose');

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

module.exports = mongoose.model('Conversation', conversationSchema);
