const mongoose = require('mongoose');
const { encryptionPlugin } = require('../mongodb-encryption');

const customerSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: String,
  email: String,
  company: String,
  isQualified: {
    type: Boolean,
    default: false
  },
  leadSource: {
    type: String,
    default: 'whatsapp'
  },
  tags: [String],
  metadata: {
    type: Map,
    of: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  lastContactedAt: Date
});

// Update timestamp on save
customerSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Apply field-level encryption to PII (GDPR/CCPA compliance)
customerSchema.plugin(encryptionPlugin, {
  fields: ['phoneNumber', 'email', 'name']
});

module.exports = mongoose.model('Customer', customerSchema);
