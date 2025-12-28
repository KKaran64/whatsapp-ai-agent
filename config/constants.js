// Configuration Constants
// Centralized configuration to avoid magic numbers and strings

module.exports = {
  // Rate Limiting
  RATE_LIMITS: {
    WEBHOOK: {
      WINDOW_MS: 1 * 60 * 1000,  // 1 minute
      MAX_REQUESTS: 100,
      MESSAGE: { error: 'Too many requests from this IP, please try again later' }
    },
    MONITORING: {
      WINDOW_MS: 1 * 60 * 1000,  // 1 minute
      MAX_REQUESTS: 30,
      MESSAGE: { error: 'Too many monitoring requests, please slow down' }
    },
    PHONE_LIMIT: {
      WINDOW_MS: 30 * 1000,      // 30 seconds
      MAX_MESSAGES: 10,
      MESSAGE: 'Please wait a moment before sending more messages'
    }
  },

  // Database
  DATABASE: {
    CONNECTION_POOL: {
      MAX_POOL_SIZE: 10,
      MIN_POOL_SIZE: 2,
      SERVER_SELECTION_TIMEOUT_MS: 5000,
      SOCKET_TIMEOUT_MS: 45000,
      FAMILY: 4  // Use IPv4
    },
    CONVERSATION_HISTORY_LIMIT: 50,  // Keep last 50 messages
    CONVERSATION_CONTEXT_LIMIT: 10   // Send last 10 to AI
  },

  // Message Processing
  MESSAGE: {
    TYPES: {
      TEXT: 'text',
      IMAGE: 'image',
      AUDIO: 'audio',
      DOCUMENT: 'document',
      VIDEO: 'video',
      LOCATION: 'location',
      CONTACTS: 'contacts',
      STICKER: 'sticker'
    },
    ALLOWED_TYPES: ['text', 'image', 'audio', 'document'],  // Whitelist
    BODY_SIZE_LIMIT: '100kb',
    DEDUPLICATION_CACHE_SIZE: 1000,
    DEDUPLICATION_TTL_MS: 5 * 60 * 1000  // 5 minutes
  },

  // Queue Processing
  QUEUE: {
    CONCURRENT_JOBS: 5,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 2000,
    RETRY_BACKOFF_TYPE: 'exponential',
    JOB_TIMEOUT_MS: 60000  // 1 minute per job
  },

  // AI Provider
  AI: {
    TIMEOUT_MS: 30000,  // 30 seconds
    MAX_TOKENS: 500,
    TEMPERATURE: 0.7
  },

  // Security
  SECURITY: {
    ENCRYPTION: {
      ALGORITHM: 'aes-256-gcm',
      IV_LENGTH: 16,
      TAG_LENGTH: 16,
      KEY_LENGTH: 32
    },
    HMAC: {
      ALGORITHM: 'sha256'
    },
    REQUEST_ID_LENGTH: 6
  },

  // Timeouts & Retries
  TIMEOUTS: {
    WHATSAPP_API_MS: 10000,   // 10 seconds
    MONGODB_CONNECT_MS: 10000, // 10 seconds
    REDIS_CONNECT_MS: 5000,    // 5 seconds
    QUEUE_RETRY_MS: 5000       // 5 seconds
  },

  // Health Check
  HEALTH: {
    CHECK_INTERVAL_MS: 5 * 60 * 1000  // 5 minutes
  },

  // Error Codes
  ERROR_CODES: {
    INVALID_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
    INTERNAL_ERROR: 'INTERNAL_SERVER_ERROR',
    INVALID_MESSAGE_TYPE: 'INVALID_MESSAGE_TYPE',
    DATABASE_ERROR: 'DATABASE_ERROR',
    AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR'
  },

  // HTTP Status Codes
  HTTP_STATUS: {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_ERROR: 500,
    SERVICE_UNAVAILABLE: 503
  }
};
