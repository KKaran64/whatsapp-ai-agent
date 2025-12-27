/**
 * MongoDB Field-Level Encryption Utility
 *
 * Encrypts sensitive fields before storing in MongoDB
 * Decrypts when retrieving from database
 *
 * Uses AES-256-GCM for encryption (authenticated encryption)
 */

const crypto = require('crypto');

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // For AES, this is always 16
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 64;

/**
 * Get encryption key from environment or generate one
 * CRITICAL: In production, ENCRYPTION_KEY must be set in environment variables
 */
function getEncryptionKey() {
  const envKey = process.env.MONGODB_ENCRYPTION_KEY;

  if (!envKey) {
    console.warn('⚠️  MONGODB_ENCRYPTION_KEY not set - using default (NOT SECURE FOR PRODUCTION)');
    console.warn('⚠️  Generate key: openssl rand -hex 32');
    console.warn('⚠️  Set in .env: MONGODB_ENCRYPTION_KEY=<your-key>');

    // Default key for development ONLY
    return Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
  }

  // Convert hex string to buffer
  return Buffer.from(envKey, 'hex');
}

const ENCRYPTION_KEY = getEncryptionKey();

/**
 * Encrypt a string value
 * @param {string} text - Text to encrypt
 * @returns {string} - Encrypted text (hex format: iv:authTag:encrypted)
 */
function encrypt(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  try {
    // Generate random IV for each encryption
    const iv = crypto.randomBytes(IV_LENGTH);

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

    // Encrypt the text
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Get authentication tag
    const authTag = cipher.getAuthTag();

    // Return IV:authTag:encrypted (all in hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('[ENCRYPTION] Failed to encrypt:', error.message);
    throw new Error('Encryption failed');
  }
}

/**
 * Decrypt a string value
 * @param {string} encryptedText - Encrypted text (format: iv:authTag:encrypted)
 * @returns {string} - Decrypted text
 */
function decrypt(encryptedText) {
  if (!encryptedText || typeof encryptedText !== 'string') {
    return encryptedText;
  }

  // Check if text is actually encrypted (has correct format)
  if (!encryptedText.includes(':')) {
    return encryptedText; // Return as-is if not encrypted
  }

  try {
    // Split the encrypted text
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      console.warn('[ENCRYPTION] Invalid encrypted format, returning as-is');
      return encryptedText;
    }

    const [ivHex, authTagHex, encrypted] = parts;

    // Convert from hex
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    console.error('[ENCRYPTION] Failed to decrypt:', error.message);
    // Return encrypted text if decryption fails (better than crashing)
    return encryptedText;
  }
}

/**
 * Hash a value (one-way, for passwords or sensitive searches)
 * @param {string} text - Text to hash
 * @returns {string} - SHA-256 hash
 */
function hash(text) {
  if (!text) return text;

  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');
}

/**
 * Hash with salt (for password storage)
 * @param {string} password - Password to hash
 * @returns {string} - Salted hash (format: salt:hash)
 */
function hashPassword(password) {
  if (!password) throw new Error('Password required');

  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const hash = crypto
    .createHash('sha256')
    .update(salt + password)
    .digest('hex');

  return `${salt}:${hash}`;
}

/**
 * Verify password against salted hash
 * @param {string} password - Password to verify
 * @param {string} storedHash - Stored hash (format: salt:hash)
 * @returns {boolean} - True if password matches
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;

  const [salt, hash] = storedHash.split(':');
  const testHash = crypto
    .createHash('sha256')
    .update(salt + password)
    .digest('hex');

  return testHash === hash;
}

/**
 * Encrypt object fields selectively
 * @param {Object} obj - Object to encrypt
 * @param {Array<string>} fields - Fields to encrypt
 * @returns {Object} - Object with encrypted fields
 */
function encryptFields(obj, fields) {
  const encrypted = { ...obj };

  for (const field of fields) {
    if (encrypted[field]) {
      encrypted[field] = encrypt(encrypted[field]);
    }
  }

  return encrypted;
}

/**
 * Decrypt object fields selectively
 * @param {Object} obj - Object to decrypt
 * @param {Array<string>} fields - Fields to decrypt
 * @returns {Object} - Object with decrypted fields
 */
function decryptFields(obj, fields) {
  const decrypted = { ...obj };

  for (const field of fields) {
    if (decrypted[field]) {
      decrypted[field] = decrypt(decrypted[field]);
    }
  }

  return decrypted;
}

/**
 * Mongoose plugin for automatic field encryption
 * Usage:
 *   schema.plugin(encryptionPlugin, { fields: ['email', 'phone'] });
 */
function encryptionPlugin(schema, options) {
  const fieldsToEncrypt = options.fields || [];

  // Encrypt before saving
  schema.pre('save', function (next) {
    for (const field of fieldsToEncrypt) {
      if (this[field] && this.isModified(field)) {
        // Only encrypt if not already encrypted
        if (!this[field].includes(':')) {
          this[field] = encrypt(this[field]);
        }
      }
    }
    next();
  });

  // Decrypt after finding
  schema.post('find', function (docs) {
    if (!Array.isArray(docs)) return;

    docs.forEach(doc => {
      for (const field of fieldsToEncrypt) {
        if (doc[field]) {
          doc[field] = decrypt(doc[field]);
        }
      }
    });
  });

  schema.post('findOne', function (doc) {
    if (!doc) return;

    for (const field of fieldsToEncrypt) {
      if (doc[field]) {
        doc[field] = decrypt(doc[field]);
      }
    }
  });
}

/**
 * Generate a new encryption key (for initial setup)
 * @returns {string} - New encryption key (hex format)
 */
function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  encrypt,
  decrypt,
  hash,
  hashPassword,
  verifyPassword,
  encryptFields,
  decryptFields,
  encryptionPlugin,
  generateEncryptionKey
};
