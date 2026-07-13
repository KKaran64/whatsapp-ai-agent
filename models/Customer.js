const mongoose = require('mongoose');
const { encryptionPlugin, blindIndexPlugin, phoneBlindIndex } = require('../mongodb-encryption');

const customerSchema = new mongoose.Schema({
  // Encrypted at rest (random IV) — NOT directly queryable. Look customers up
  // via phoneHash / Customer.phoneFilter(), never by this field's plaintext.
  phoneNumber: {
    type: String,
    required: true
  },
  // Deterministic blind index of phoneNumber — the actual lookup key.
  phoneHash: {
    type: String,
    unique: true,
    sparse: true,
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

// Look up a customer by phone without exposing the encrypted field to queries.
// Spreads into any query (findOne/updateOne/etc). The $or covers the migration
// window: new docs match on phoneHash, un-backfilled legacy docs still match on
// the (then-plaintext) phoneNumber. After backfill the second clause is inert
// (encrypted phones never equal plaintext) and can be dropped.
customerSchema.statics.phoneFilter = function (phone) {
  return { $or: [{ phoneHash: phoneBlindIndex(phone) }, { phoneNumber: phone }] };
};

// Blind index MUST be registered before the encryption plugin so it hashes the
// plaintext phone, not the ciphertext.
customerSchema.plugin(blindIndexPlugin, { sourceField: 'phoneNumber', hashField: 'phoneHash' });

// Field-level encryption for PII (GDPR/CCPA). phoneNumber is encrypted at rest;
// phoneHash (above) provides deterministic lookup.
customerSchema.plugin(encryptionPlugin, {
  fields: ['phoneNumber', 'email', 'name']
});

module.exports = mongoose.model('Customer', customerSchema);
