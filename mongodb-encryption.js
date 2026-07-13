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
 * Get encryption key from environment
 * CRITICAL: ENCRYPTION_KEY must be set in environment variables
 * SECURITY: Fails fast in production if key is missing (no insecure defaults)
 */
function getEncryptionKey() {
  const envKey = process.env.MONGODB_ENCRYPTION_KEY;

  if (!envKey) {
    const errorMsg = 'FATAL: MONGODB_ENCRYPTION_KEY must be set in environment variables';
    console.error('❌', errorMsg);
    console.error('💡 Generate key: openssl rand -hex 32');
    console.error('💡 Add to Render: Environment → MONGODB_ENCRYPTION_KEY=<your-key>');

    // SECURITY: Fail-fast - never use default keys
    throw new Error(errorMsg);
  }

  // Validate key format (must be 64 hex characters = 32 bytes)
  if (envKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(envKey)) {
    throw new Error('Invalid MONGODB_ENCRYPTION_KEY format - must be 64 hex characters (32 bytes)');
  }

  // Convert hex string to buffer
  return Buffer.from(envKey, 'hex');
}

const ENCRYPTION_KEY = getEncryptionKey();

// ─────────────────────────────────────────────────────────────────────
// Blind index (deterministic keyed hash) — lets an encrypted field still be
// looked up by equality. AES-GCM here uses a random IV per encryption, so an
// encrypted phone can never be matched by a query; the blind index is the
// deterministic companion you actually query on.
// ─────────────────────────────────────────────────────────────────────
function getBlindIndexKey() {
  const envKey = process.env.PHONE_HASH_KEY;
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }
  // No dedicated key set → derive a STABLE sub-key from the encryption key.
  // (Domain-separated so it isn't literally the cipher key.) This means the
  // blind index survives as long as MONGODB_ENCRYPTION_KEY is stable — which
  // it must be anyway, or nothing decrypts. Setting PHONE_HASH_KEY later
  // changes every hash, so only do that alongside a re-run of the backfill.
  return crypto.createHash('sha256').update(ENCRYPTION_KEY).update('phone-blind-index-v1').digest();
}

const BLIND_INDEX_KEY = getBlindIndexKey();

/**
 * Deterministic, keyed blind index for a phone number.
 * Normalizes to digits only so "+91 98765 43210" and "919876543210" collide,
 * then HMAC-SHA256 with the server-side key. Same phone → same hash (queryable);
 * a DB dump without the key can't be reversed (keyed, unlike a plain hash).
 * @param {string} phone
 * @returns {string} 64-char hex, or '' for empty input
 */
function phoneBlindIndex(phone) {
  if (!phone) return '';
  const normalized = String(phone).replace(/\D/g, '');
  if (!normalized) return '';
  return crypto.createHmac('sha256', BLIND_INDEX_KEY).update(normalized).digest('hex');
}

/**
 * Mongoose plugin: keeps a blind-index field in sync with a plaintext source
 * field on save. MUST be applied BEFORE the encryptionPlugin so the hash is
 * computed from the plaintext value (not the ciphertext).
 * Usage: schema.plugin(blindIndexPlugin, { sourceField: 'phoneNumber', hashField: 'phoneHash' });
 */
function blindIndexPlugin(schema, options) {
  const sourceField = options.sourceField;
  const hashField = options.hashField || `${sourceField}Hash`;

  schema.pre('save', function (next) {
    const value = this[sourceField];
    // Only hash when the source is present AND still plaintext. Guard against
    // ciphertext (would produce a garbage, unqueryable hash).
    if (value && this.isModified(sourceField) && !isEncrypted(value)) {
      this[hashField] = phoneBlindIndex(value);
    }
    next();
  });
}

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
    return encryptedText; // Return as-is if not encrypted (normal for old/unencrypted data)
  }

  try {
    // Split the encrypted text
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      // v53.33: Don't spam logs - this is normal for unencrypted data
      return encryptedText;
    }

    const [ivHex, authTagHex, encrypted] = parts;

    // Validate hex format before decryption (prevent spam on URLs/text with colons)
    if (!/^[0-9a-fA-F]+$/.test(ivHex) || !/^[0-9a-fA-F]+$/.test(authTagHex)) {
      // Not actually encrypted data (e.g., URLs like "http://example.com:8080")
      return encryptedText;
    }

    // Convert from hex
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    // Validate lengths
    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      // Invalid encryption format, return as-is silently
      return encryptedText;
    }

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    // v53.33: Only log if it looks like it SHOULD be encrypted but failed
    // (Don't spam logs for normal unencrypted data)
    const looksEncrypted = encryptedText.split(':').length === 3 &&
                          /^[0-9a-fA-F:]+$/.test(encryptedText);
    if (looksEncrypted) {
      console.error('[ENCRYPTION] Decryption failed (corrupted data?):', error.message);
    }
    // Return encrypted text if decryption fails (better than crashing)
    return encryptedText;
  }
}

/**
 * Check whether a string is in this module's encrypted format
 * (iv:authTag:ciphertext — 32 hex chars, 32 hex chars, hex).
 * Strict on purpose: a customer message containing a colon ("10:30",
 * "Note: ...") must NOT be mistaken for ciphertext, and plaintext must
 * never be skipped by the encryption hooks just because it has a colon.
 */
const ENCRYPTED_FORMAT = /^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;
function isEncrypted(text) {
  return typeof text === 'string' && ENCRYPTED_FORMAT.test(text);
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
        // Only encrypt if not already encrypted (strict format check —
        // plaintext containing ':' must still be encrypted)
        if (!isEncrypted(this[field])) {
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
  isEncrypted,
  phoneBlindIndex,
  blindIndexPlugin,
  hash,
  hashPassword,
  verifyPassword,
  encryptFields,
  decryptFields,
  encryptionPlugin,
  generateEncryptionKey
};
