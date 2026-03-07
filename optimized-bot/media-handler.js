/**
 * Media Handler for Token-Optimized Bot
 *
 * Pre-uploads product images to WhatsApp Media API and caches media IDs.
 * Provides fast media sending without re-uploading.
 *
 * Features:
 * - Pre-upload product images on startup
 * - Cache media IDs in memory (24-hour validity on WhatsApp)
 * - Map products to media IDs
 * - Support PDF catalogs
 */

const axios = require('axios');
const FormData = require('form-data');

// Product to image URL mapping (using existing product images)
const PRODUCT_IMAGES = {
  coasters: [
    'https://9cork.com/cdn/shop/products/IMG_0157.jpg',
    'https://9cork.com/cdn/shop/products/IMG_0159.jpg'
  ],
  desk_organizer: [
    'https://9cork.com/cdn/shop/products/DSC_0012.jpg',
    'https://9cork.com/cdn/shop/products/DSC_0014.jpg'
  ],
  wall_tiles: [
    'https://9cork.com/cdn/shop/products/cork-wall-tiles.jpg'
  ],
  yoga_mat: [
    'https://9cork.com/cdn/shop/products/cork-yoga-mat.jpg',
    'https://9cork.com/cdn/shop/products/cork-yoga-blocks.jpg'
  ],
  lampshade: [
    'https://9cork.com/cdn/shop/products/cork-pendant-lamp.jpg',
    'https://9cork.com/cdn/shop/products/cork-table-lamp.jpg'
  ],
  diary: [
    'https://9cork.com/cdn/shop/products/cork-diary-a5.jpg'
  ],
  calendar: [
    'https://9cork.com/cdn/shop/products/cork-desk-calendar.jpg'
  ],
  planter: [
    'https://9cork.com/cdn/shop/products/cork-planter.jpg'
  ],
  bag: [
    'https://9cork.com/cdn/shop/products/cork-laptop-bag.jpg'
  ],
  wallet: [
    'https://9cork.com/cdn/shop/products/cork-wallet.jpg'
  ]
};

// PDF catalog URLs (from environment)
const CATALOG_TYPES = {
  horeca_catalog: 'PDF_CATALOG_HORECA',
  products_catalog: 'PDF_CATALOG_PRODUCTS',
  combos_catalog: 'PDF_CATALOG_COMBOS'
};

class MediaHandler {
  constructor(config) {
    this.config = config;
    this.whatsappToken = config.WHATSAPP_TOKEN;
    this.phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID;

    // Media ID cache: product -> { mediaId, uploadedAt }
    this.mediaCache = new Map();

    // Catalog URLs cache
    this.catalogUrls = {
      horeca_catalog: config.PDF_CATALOG_HORECA || null,
      products_catalog: config.PDF_CATALOG_PRODUCTS || null,
      combos_catalog: config.PDF_CATALOG_COMBOS || null
    };

    this.stats = {
      uploads: 0,
      cacheHits: 0,
      sends: 0,
      errors: 0
    };

    // Media ID validity period (WhatsApp keeps for 24 hours)
    this.CACHE_TTL = 23 * 60 * 60 * 1000; // 23 hours to be safe
  }

  /**
   * Pre-upload all product images on startup
   * Call this after initialization
   */
  async preloadImages() {
    console.log('[MediaHandler] Pre-uploading product images...');

    for (const [product, urls] of Object.entries(PRODUCT_IMAGES)) {
      if (urls && urls.length > 0) {
        try {
          // Upload first image for each product
          const mediaId = await this._uploadFromUrl(urls[0]);
          if (mediaId) {
            this.mediaCache.set(product, {
              mediaId,
              uploadedAt: Date.now(),
              url: urls[0]
            });
            console.log(`[MediaHandler] Cached ${product}: ${mediaId}`);
          }
        } catch (error) {
          console.error(`[MediaHandler] Failed to pre-upload ${product}:`, error.message);
        }
      }
    }

    console.log(`[MediaHandler] Pre-loaded ${this.mediaCache.size} product images`);
  }

  /**
   * Upload image from URL to WhatsApp Media API
   */
  async _uploadFromUrl(imageUrl) {
    try {
      this.stats.uploads++;

      // Download image
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      const imageBuffer = Buffer.from(imageResponse.data);
      const contentType = imageResponse.headers['content-type'] || 'image/jpeg';

      // Upload to WhatsApp
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: 'product.jpg',
        contentType
      });
      formData.append('messaging_product', 'whatsapp');
      formData.append('type', contentType);

      const uploadResponse = await axios.post(
        `https://graph.facebook.com/v18.0/${this.phoneNumberId}/media`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`,
            ...formData.getHeaders()
          },
          timeout: 60000
        }
      );

      return uploadResponse.data.id;
    } catch (error) {
      console.error('[MediaHandler] Upload error:', error.message);
      this.stats.errors++;
      return null;
    }
  }

  /**
   * Get cached media ID or upload new
   */
  async getMediaId(product) {
    const cached = this.mediaCache.get(product);

    if (cached && Date.now() - cached.uploadedAt < this.CACHE_TTL) {
      this.stats.cacheHits++;
      return cached.mediaId;
    }

    // Need to upload
    const urls = PRODUCT_IMAGES[product];
    if (!urls || urls.length === 0) {
      console.warn(`[MediaHandler] No images for product: ${product}`);
      return null;
    }

    const mediaId = await this._uploadFromUrl(urls[0]);
    if (mediaId) {
      this.mediaCache.set(product, {
        mediaId,
        uploadedAt: Date.now(),
        url: urls[0]
      });
    }

    return mediaId;
  }

  /**
   * Send image to WhatsApp user
   */
  async sendImage(phoneNumber, product, caption = null) {
    try {
      const mediaId = await this.getMediaId(product);

      if (!mediaId) {
        console.warn(`[MediaHandler] No media ID for ${product}`);
        return false;
      }

      this.stats.sends++;

      const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'image',
        image: {
          id: mediaId
        }
      };

      if (caption) {
        payload.image.caption = caption;
      }

      await axios.post(
        `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      console.log(`[MediaHandler] Sent ${product} image to ${phoneNumber.slice(-4)}`);
      return true;
    } catch (error) {
      console.error(`[MediaHandler] Send error:`, error.message);
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Send PDF catalog
   */
  async sendCatalog(phoneNumber, catalogType, caption = null) {
    try {
      const catalogUrl = this.catalogUrls[catalogType];

      if (!catalogUrl) {
        console.warn(`[MediaHandler] No URL for catalog: ${catalogType}`);
        return false;
      }

      this.stats.sends++;

      const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'document',
        document: {
          link: catalogUrl,
          filename: this._getCatalogFilename(catalogType)
        }
      };

      if (caption) {
        payload.document.caption = caption;
      }

      await axios.post(
        `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      console.log(`[MediaHandler] Sent ${catalogType} to ${phoneNumber.slice(-4)}`);
      return true;
    } catch (error) {
      console.error(`[MediaHandler] Catalog send error:`, error.message);
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Get catalog filename
   */
  _getCatalogFilename(catalogType) {
    const filenames = {
      horeca_catalog: '9Cork-HORECA-Catalog.pdf',
      products_catalog: '9Cork-Products-Catalog.pdf',
      combos_catalog: '9Cork-Gifting-Combos-Catalog.pdf'
    };
    return filenames[catalogType] || '9Cork-Catalog.pdf';
  }

  /**
   * Handle media trigger from response
   * @param {string} phoneNumber - WhatsApp number
   * @param {string} mediaType - Product or catalog type
   * @returns {Promise<boolean>} Success status
   */
  async handleMediaTrigger(phoneNumber, mediaType) {
    if (!mediaType) return false;

    const normalizedType = mediaType.toLowerCase().trim();

    // Check if it's a catalog
    if (normalizedType.includes('catalog')) {
      return this.sendCatalog(phoneNumber, normalizedType);
    }

    // Check if it's a product
    if (PRODUCT_IMAGES[normalizedType]) {
      return this.sendImage(phoneNumber, normalizedType);
    }

    // Try to map common names
    const productMap = {
      'coaster': 'coasters',
      'organizer': 'desk_organizer',
      'desk': 'desk_organizer',
      'tiles': 'wall_tiles',
      'yoga': 'yoga_mat',
      'lamp': 'lampshade',
      'light': 'lampshade',
      'diaries': 'diary',
      'calendars': 'calendar',
      'planters': 'planter',
      'bags': 'bag',
      'wallets': 'wallet',
      'horeca': 'horeca_catalog'
    };

    const mapped = productMap[normalizedType];
    if (mapped) {
      if (mapped.includes('catalog')) {
        return this.sendCatalog(phoneNumber, mapped);
      }
      return this.sendImage(phoneNumber, mapped);
    }

    console.warn(`[MediaHandler] Unknown media type: ${mediaType}`);
    return false;
  }

  /**
   * Get multiple images for a product
   */
  async sendMultipleImages(phoneNumber, product, maxImages = 2) {
    const urls = PRODUCT_IMAGES[product];
    if (!urls || urls.length === 0) return false;

    const toSend = urls.slice(0, maxImages);
    let success = true;

    for (const url of toSend) {
      try {
        // Upload and send each image
        const mediaId = await this._uploadFromUrl(url);
        if (mediaId) {
          await axios.post(
            `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
            {
              messaging_product: 'whatsapp',
              to: phoneNumber,
              type: 'image',
              image: { id: mediaId }
            },
            {
              headers: {
                'Authorization': `Bearer ${this.whatsappToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
          this.stats.sends++;
        }
      } catch (error) {
        console.error(`[MediaHandler] Multi-image error:`, error.message);
        success = false;
      }

      // Small delay between images
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return success;
  }

  /**
   * Clear expired cache entries
   */
  cleanCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.mediaCache.entries()) {
      if (now - value.uploadedAt >= this.CACHE_TTL) {
        this.mediaCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[MediaHandler] Cleaned ${cleaned} expired cache entries`);
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.mediaCache.size,
      cachedProducts: Array.from(this.mediaCache.keys())
    };
  }
}

module.exports = MediaHandler;
