// State telemetry log — v61 Phase B.3
//
// Stores every state transition + enforcer action so we can:
//   1. See how conversations actually flow (which states get reached, which get stuck)
//   2. Spot when the LLM tries to misbehave (enforcer OVERRIDE/STRIP events)
//   3. Power the /admin/state-dashboard endpoint
//
// Stored separately from Conversation so we can purge it independently (this
// is observability data, not customer history).

const mongoose = require('mongoose');

const stateLogSchema = new mongoose.Schema({
  customerPhone: { type: String, required: true, index: true },
  // timestamp index declared at schema level (below) with TTL — no inline index here
  timestamp: { type: Date, default: Date.now },

  // State info
  stateCode: { type: String, required: true, index: true },
  stateReason: String,
  previousStateCode: String,  // For tracking transitions

  // Enforcer telemetry
  enforcerAction: {
    type: String,
    enum: ['pass', 'strip', 'override', 'no_action'],
    default: 'no_action'
  },
  enforcerReason: String,
  enforcerViolations: [String],

  // Quote context (when applicable)
  productQuery: String,
  quantity: Number,
  customerType: { type: String, enum: ['end_consumer', 'reseller', null] },
  hadVerifiedQuote: Boolean,

  // Message snippets for debugging
  customerMessage: String,  // last 100 chars
  llmReplyBefore: String,   // last 150 chars of LLM raw output
  finalReply: String        // last 150 chars of what customer actually saw
}, {
  timestamps: false  // we have our own `timestamp` field
});

// TTL index — auto-delete logs after 30 days to keep collection small
stateLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Compound index for the dashboard's "recent conversations" query
stateLogSchema.index({ customerPhone: 1, timestamp: -1 });

module.exports = mongoose.model('StateLog', stateLogSchema);
