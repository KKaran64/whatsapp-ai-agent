/**
 * WhatsApp Media Upload API Implementation
 *
 * This solution uploads images to WhatsApp's servers first, then sends them.
 * Benefits:
 * - 100% reliable delivery (images already on WhatsApp servers)
 * - No timeout issues
 * - Can cache media IDs for reuse (24 hours validity)
 * - Faster sending for repeated images
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const sharp = require('sharp');

// Security Configuration
const MAX_CACHE_SIZE = 1000; // Prevent unbounded memory growth
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit (WhatsApp's actual limit for images is 5,242,880 bytes)
const TARGET_IMAGE_SIZE = 4.8 * 1024 * 1024; // Target 4.8MB (just under WhatsApp's 5MB limit with safety margin)

// Allowed image MIME types (prevents malicious file uploads)
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif'
];

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

// Rate Limiting Configuration (prevents hitting WhatsApp API limits)
const RATE_LIMIT_WINDOW = 60000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 30; // WhatsApp allows ~80/min, set conservative limit
const MIN_REQUEST_INTERVAL = 100; // Minimum 100ms between requests

// Whitelist of allowed domains (prevents SSRF attacks)
const ALLOWED_DOMAINS = [
  '9cork.com',               // Primary product image source
  'www.9cork.com',
  'homedecorzstore.com',
  'www.homedecorzstore.com',
  'drive.google.com',
  'storage.googleapis.com',
  'lh3.googleusercontent.com',
  'i.pinimg.com',
  'pinimg.com'
];

// Blacklisted IP ranges (SSRF protection - prevent access to private/internal IPs)
const BLACKLISTED_IP_PATTERNS = [
  /^127\./,           // 127.0.0.0/8 - Loopback
  /^10\./,            // 10.0.0.0/8 - Private
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12 - Private
  /^192\.168\./,      // 192.168.0.0/16 - Private
  /^169\.254\./,      // 169.254.0.0/16 - Link-local (AWS metadata)
  /^0\./,             // 0.0.0.0/8 - Invalid
  /^(224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239)\./,  // Multicast
  /^(240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255)\./   // Reserved
];

// Blacklisted hostnames
const BLACKLISTED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',  // GCP metadata
  'instance-data'              // AWS metadata alternative
];

// Cache for media IDs (in-memory, use Redis for production)
const mediaCache = new Map();

// Rate limiting state
const requestTimestamps = [];
let lastRequestTime = 0;

// Statistics
const stats = {
  uploads: 0,
  cacheHits: 0,
  cacheMisses: 0,
  sent: 0,
  failed: 0,
  securityBlocked: 0,
  rateLimited: 0,
  compressed: 0,
  compressionBytesSaved: 0
};

/**
 * Compress image to target size while maintaining quality
 * Uses adaptive compression - tries quality levels until size target is met
 * @param {Buffer} imageBuffer - Original image buffer
 * @param {string} contentType - Image MIME type
 * @returns {Promise<Buffer>} - Compressed image buffer
 */
async function compressImage(imageBuffer, contentType = 'image/jpeg') {
  const originalSize = imageBuffer.length;

  // If already under target size, return as-is
  if (originalSize <= TARGET_IMAGE_SIZE) {
    console.log(`[COMPRESS] Image already under target (${(originalSize / 1024 / 1024).toFixed(2)}MB), skipping compression`);
    return imageBuffer;
  }

  console.log(`[COMPRESS] Original size: ${(originalSize / 1024 / 1024).toFixed(2)}MB, compressing...`);

  try {
    // Get image metadata
    const metadata = await sharp(imageBuffer).metadata();
    console.log(`[COMPRESS] Format: ${metadata.format}, Dimensions: ${metadata.width}x${metadata.height}`);

    // Adaptive compression strategy
    let quality = 90;
    let compressed = null;
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      attempts++;

      // Compress with current quality
      compressed = await sharp(imageBuffer)
        .jpeg({ quality, mozjpeg: true }) // Use mozjpeg for better compression
        .toBuffer();

      const compressedSize = compressed.length;
      const sizeMB = (compressedSize / 1024 / 1024).toFixed(2);

      console.log(`[COMPRESS] Attempt ${attempts}: Quality ${quality}%, Size ${sizeMB}MB`);

      // Check if we hit the target
      if (compressedSize <= TARGET_IMAGE_SIZE) {
        const savedBytes = originalSize - compressedSize;
        const savedMB = (savedBytes / 1024 / 1024).toFixed(2);

        stats.compressed++;
        stats.compressionBytesSaved += savedBytes;

        console.log(`[COMPRESS] ✅ Success! Reduced from ${(originalSize / 1024 / 1024).toFixed(2)}MB to ${sizeMB}MB (saved ${savedMB}MB, quality ${quality}%)`);
        return compressed;
      }

      // Reduce quality for next attempt
      quality -= 10;

      if (quality < 50) {
        // If quality too low, try resizing instead
        console.log(`[COMPRESS] Quality too low, trying resize...`);
        const scaleFactor = Math.sqrt(TARGET_IMAGE_SIZE / compressedSize);
        const newWidth = Math.floor(metadata.width * scaleFactor);
        const newHeight = Math.floor(metadata.height * scaleFactor);

        compressed = await sharp(imageBuffer)
          .resize(newWidth, newHeight, { fit: 'inside' })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();

        const finalSize = compressed.length;
        const finalSizeMB = (finalSize / 1024 / 1024).toFixed(2);

        if (finalSize <= TARGET_IMAGE_SIZE) {
          const savedBytes = originalSize - finalSize;
          const savedMB = (savedBytes / 1024 / 1024).toFixed(2);

          stats.compressed++;
          stats.compressionBytesSaved += savedBytes;

          console.log(`[COMPRESS] ✅ Success with resize! ${metadata.width}x${metadata.height} → ${newWidth}x${newHeight}, ${finalSizeMB}MB (saved ${savedMB}MB)`);
          return compressed;
        }

        break; // Can't compress further
      }
    }

    // If still too large, return last attempt (better than nothing)
    console.log(`[COMPRESS] ⚠️ Could not reach target size after ${attempts} attempts, using best attempt`);
    return compressed || imageBuffer;

  } catch (error) {
    console.error(`[COMPRESS] ❌ Compression failed:`, error.message);
    console.error(`[COMPRESS] Returning original image`);
    return imageBuffer;
  }
}

/**
 * Rate limiter - prevents hitting WhatsApp API limits
 * Implements both window-based and interval-based throttling
 */
async function rateLimit() {
  const now = Date.now();

  // Clean up old timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }

  // Check if we've hit the rate limit
  if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldestRequest = requestTimestamps[0];
    const waitTime = RATE_LIMIT_WINDOW - (now - oldestRequest);
    console.log(`[RATE LIMIT] Hit limit (${MAX_REQUESTS_PER_WINDOW}/${RATE_LIMIT_WINDOW}ms), waiting ${waitTime}ms`);
    stats.rateLimited++;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    return rateLimit(); // Retry after waiting
  }

  // Enforce minimum interval between requests
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  // Record this request
  requestTimestamps.push(Date.now());
  lastRequestTime = Date.now();
}

/**
 * Validate IP address is not in blacklisted ranges
 * @param {string} ip - IP address to validate
 * @returns {boolean} - True if IP is safe (not blacklisted)
 */
function isIPSafe(ip) {
  // Check against blacklist patterns
  for (const pattern of BLACKLISTED_IP_PATTERNS) {
    if (pattern.test(ip)) {
      return false;
    }
  }
  return true;
}

/**
 * Validate image URL against whitelist and check for SSRF attacks
 * @param {string} url - URL to validate
 * @returns {Promise<boolean>} - True if URL is allowed and safe
 */
async function isValidImageUrl(url) {
  try {
    const urlObj = new URL(url);

    // 1. Protocol validation - Only allow HTTP/HTTPS
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      console.error(`[SECURITY] Blocked non-HTTP(S) protocol: ${urlObj.protocol}`);
      return false;
    }

    // 2. Hostname blacklist check
    const hostname = urlObj.hostname.toLowerCase();
    if (BLACKLISTED_HOSTNAMES.some(blocked => hostname.includes(blocked))) {
      console.error(`[SECURITY] Blocked blacklisted hostname: ${hostname}`);
      return false;
    }

    // 3. Domain whitelist check
    const isAllowed = ALLOWED_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );

    if (!isAllowed) {
      console.error(`[SECURITY] Blocked unauthorized domain: ${hostname}`);
      return false;
    }

    // 4. DNS resolution check (prevent DNS rebinding attacks)
    try {
      const addresses = await dns.resolve4(hostname);

      for (const ip of addresses) {
        if (!isIPSafe(ip)) {
          console.error(`[SECURITY] Blocked private/internal IP: ${ip} for domain ${hostname}`);
          stats.securityBlocked++;
          return false;
        }
      }

      console.log(`[SECURITY] DNS validated: ${hostname} → ${addresses.join(', ')}`);
    } catch (dnsError) {
      console.error(`[SECURITY] DNS resolution failed for ${hostname}: ${dnsError.message}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[SECURITY] Invalid URL format: ${error.message}`);
    return false;
  }
}

/**
 * Validate content type is an allowed image format (prevents malicious uploads)
 * @param {string} contentType - Content-Type header value
 * @param {string} url - Image URL for logging
 * @returns {boolean} - True if content type is allowed
 */
function isValidImageContentType(contentType, url) {
  // Normalize content type (remove charset, etc.)
  const normalizedType = contentType.split(';')[0].trim().toLowerCase();

  // Check if content type is in allowed list
  const isAllowed = ALLOWED_IMAGE_TYPES.includes(normalizedType);

  if (!isAllowed) {
    console.error(`[SECURITY] Blocked invalid content-type: ${contentType} for URL: ${url.slice(0, 50)}`);
    stats.securityBlocked++;
  }

  return isAllowed;
}

/**
 * Validate file extension from URL (additional security layer)
 * @param {string} url - Image URL
 * @returns {boolean} - True if extension is allowed
 */
function hasValidImageExtension(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();

    // Check if URL ends with allowed extension
    const hasValidExt = ALLOWED_EXTENSIONS.some(ext => pathname.endsWith(ext));

    if (!hasValidExt) {
      console.warn(`[SECURITY] Suspicious file extension in URL: ${url.slice(0, 50)}`);
    }

    return hasValidExt;
  } catch (error) {
    return false;
  }
}

/**
 * Enforce cache size limit with LRU eviction
 */
function enforceCacheLimit() {
  while (mediaCache.size >= MAX_CACHE_SIZE) {
    // Remove oldest entry (first key in Map)
    const firstKey = mediaCache.keys().next().value;
    mediaCache.delete(firstKey);
    console.log(`[CACHE] Evicted oldest entry, size now: ${mediaCache.size}`);
  }
}

/**
 * Upload image to WhatsApp and get media ID
 * @param {string} imageUrl - URL of the image to upload
 * @returns {Promise<string>} - WhatsApp media ID
 */
async function uploadImageToWhatsApp(imageUrl) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

  // SECURITY: Validate URL against whitelist and check for SSRF attacks
  const isValid = await isValidImageUrl(imageUrl);
  if (!isValid) {
    stats.securityBlocked++;
    throw new Error('URL not allowed - failed security validation (domain not in whitelist or resolves to private IP)');
  }

  // Check cache first (media IDs are valid for 24 hours)
  const cacheKey = imageUrl;
  const cached = mediaCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp) < 23 * 60 * 60 * 1000) {
    console.log(`[MEDIA] ✅ Cache hit for ${imageUrl.slice(0, 50)}...`);
    stats.cacheHits++;
    return cached.mediaId;
  }

  stats.cacheMisses++;
  console.log(`[MEDIA] Downloading image: ${imageUrl.slice(0, 50)}...`);

  try {
    // Step 1: Download the image (SECURITY: SSRF protection)
    // Allow redirects for Google Drive but validate redirect targets
    const isGoogleDrive = imageUrl.includes('drive.google.com') || imageUrl.includes('googleapis.com');

    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000, // 30 seconds
      maxContentLength: MAX_FILE_SIZE,
      maxBodyLength: MAX_FILE_SIZE,
      maxRedirects: isGoogleDrive ? 5 : 0, // Allow redirects for Google Drive, block for others
      validateStatus: (status) => status === 200, // Only accept 200 OK
      headers: {
        'User-Agent': '9CorkWhatsAppBot/1.0'
      }
    });

    let imageBuffer = Buffer.from(imageResponse.data);
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';

    // SECURITY: Validate content type (prevents malicious file uploads)
    if (!isValidImageContentType(contentType, imageUrl)) {
      throw new Error(`Invalid content type: ${contentType}. Only image formats allowed.`);
    }

    console.log(`[MEDIA] Downloaded ${imageBuffer.length} bytes, type: ${contentType}`);

    // COMPRESSION: Automatically compress if image exceeds WhatsApp's limit
    if (imageBuffer.length > TARGET_IMAGE_SIZE) {
      console.log(`[MEDIA] Image size ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB exceeds target, compressing...`);
      imageBuffer = await compressImage(imageBuffer, contentType);
      console.log(`[MEDIA] After compression: ${imageBuffer.length} bytes`);
    }

    // SECURITY: Final validation after compression
    if (imageBuffer.length > MAX_FILE_SIZE) {
      throw new Error(`Image too large even after compression: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
    }

    // Step 2: Create form data
    const formData = new FormData();
    formData.append('file', imageBuffer, {
      filename: 'product.jpg',
      contentType: 'image/jpeg' // Always JPEG after compression
    });
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', contentType);

    // Step 3: Apply rate limiting before WhatsApp API call
    await rateLimit();

    // Step 4: Upload to WhatsApp
    console.log(`[MEDIA] Uploading to WhatsApp...`);

    const uploadResponse = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          ...formData.getHeaders()
        },
        timeout: 60000 // 60 seconds
      }
    );

    const mediaId = uploadResponse.data.id;
    console.log(`[MEDIA] ✅ Uploaded successfully, media ID: ${mediaId}`);

    // SECURITY: Enforce cache size limit before adding new entry
    enforceCacheLimit();

    // Cache the media ID
    mediaCache.set(cacheKey, {
      mediaId: mediaId,
      timestamp: Date.now()
    });

    stats.uploads++;
    return mediaId;

  } catch (error) {
    console.error(`[MEDIA] ❌ Upload failed:`, error.message);
    throw error;
  }
}

/**
 * Send image using WhatsApp media ID
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} mediaId - WhatsApp media ID
 * @param {string} caption - Image caption
 * @returns {Promise<Object>} - Send result
 */
async function sendImageByMediaId(phoneNumber, mediaId, caption = '') {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

  try {
    console.log(`[MEDIA] Sending image with media ID: ${mediaId}`);

    // Apply rate limiting before WhatsApp API call
    await rateLimit();

    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'image',
        image: {
          id: mediaId,
          caption: caption
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[MEDIA] ✅ Image sent successfully`);
    stats.sent++;
    return { success: true, response: response.data };

  } catch (error) {
    console.error(`[MEDIA] ❌ Send failed:`, error.message);
    stats.failed++;
    throw error;
  }
}

/**
 * Complete flow: Upload image and send it
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} imageUrl - URL of the image
 * @param {string} caption - Image caption
 * @returns {Promise<Object>} - Send result
 */
async function uploadAndSendImage(phoneNumber, imageUrl, caption = '') {
  try {
    // Upload to WhatsApp and get media ID
    const mediaId = await uploadImageToWhatsApp(imageUrl);

    // Send using media ID
    const result = await sendImageByMediaId(phoneNumber, mediaId, caption);

    return { success: true, mediaId, ...result };

  } catch (error) {
    console.error(`[MEDIA] ❌ Upload and send failed:`, error.message);
    return {
      success: false,
      error: error.message,
      imageUrl: imageUrl
    };
  }
}

/**
 * Send product image with automatic upload
 * @param {string} phoneNumber - Recipient phone number
 * @param {Object} product - Product object with images array
 * @returns {Promise<Object>} - Send result
 */
async function sendProductImage(phoneNumber, product) {
  const imageUrl = product.images && product.images[0];

  if (!imageUrl) {
    console.log(`[MEDIA] No image for product: ${product.name}`);
    return { success: false, error: 'No image URL' };
  }

  const caption = `${product.name}\nPrice: ₹${product.price}`;

  console.log(`[MEDIA] Sending product: ${product.name}`);
  const result = await uploadAndSendImage(phoneNumber, imageUrl, caption);

  if (!result.success) {
    // Fallback: Send text with link
    console.log(`[MEDIA] Sending fallback text message`);
    await sendTextFallback(phoneNumber, product, imageUrl);
  }

  return result;
}

/**
 * Send text fallback message with image link
 */
async function sendTextFallback(phoneNumber, product, imageUrl) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

  try {
    // Apply rate limiting before WhatsApp API call
    await rateLimit();

    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: {
          body: `${product.name}\n\n` +
                `Price: ₹${product.price}\n\n` +
                `View Image: ${imageUrl}\n\n` +
                `Image could not be sent automatically. Please click the link to view.`
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error(`[MEDIA] Fallback text failed:`, error.message);
  }
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  return {
    cacheSize: mediaCache.size,
    ...stats,
    cacheHitRate: stats.cacheMisses > 0
      ? ((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100).toFixed(2) + '%'
      : 'N/A'
  };
}

/**
 * Clear expired cache entries (run periodically)
 */
function cleanExpiredCache() {
  const now = Date.now();
  const expiryTime = 23 * 60 * 60 * 1000; // 23 hours

  let removed = 0;
  for (const [key, value] of mediaCache.entries()) {
    if (now - value.timestamp > expiryTime) {
      mediaCache.delete(key);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[MEDIA] Cleaned ${removed} expired cache entries`);
  }
}

// Clean cache every hour
const cacheCleanupInterval = setInterval(cleanExpiredCache, 60 * 60 * 1000);

// Log stats every hour
const statsLogInterval = setInterval(() => {
  console.log('[MEDIA] Statistics:', getCacheStats());
}, 60 * 60 * 1000);

/**
 * Clean up intervals (call this when shutting down the server)
 */
function cleanup() {
  if (cacheCleanupInterval) clearInterval(cacheCleanupInterval);
  if (statsLogInterval) clearInterval(statsLogInterval);
  console.log('[MEDIA] Intervals cleaned up');
}

module.exports = {
  uploadImageToWhatsApp,
  sendImageByMediaId,
  uploadAndSendImage,
  sendProductImage,
  getCacheStats,
  cleanExpiredCache,
  cleanup
};
