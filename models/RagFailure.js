const mongoose = require('mongoose');

const ragFailureSchema = new mongoose.Schema({
  customerPhone: { type: String, index: true },
  customerMessage: String,
  failureType: {
    type: String,
    enum: ['embedding_error', 'no_retrieval', 'bad_retrieval', 'pinecone_timeout', 'classification_error'],
    required: true
  },
  context: { type: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now, index: true }
});

// Auto-cleanup after 30 days
ragFailureSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('RagFailure', ragFailureSchema);
