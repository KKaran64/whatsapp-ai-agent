// Product Model for 9 Cork Products
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  productId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  category: {
    type: String,
    required: true,
    index: true
  },
  price: {
    type: Number,
    required: true
  },
  images: [{
    type: String
  }],
  aliases: {
    type: String,
    default: ''
  },
  tags: {
    type: String,
    default: ''
  },
  source: {
    type: String,
    default: ''
  },
  metadata: {
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }
}, {
  timestamps: true
});

// Indexes for fast search
productSchema.index({ name: 'text', category: 'text', tags: 'text' });
productSchema.index({ category: 1, price: 1 });

module.exports = mongoose.model('Product', productSchema);
