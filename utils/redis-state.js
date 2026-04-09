// utils/redis-state.js
// Redis-backed sentImagesTracker with in-memory fallback (when Redis unavailable)
// Uses Redis SET data structure per phone, with 30-minute TTL.

const SENT_IMAGES_TTL_SECONDS = 30 * 60; // 30 minutes

class RedisSentImagesTracker {
  constructor(redisClient) {
    this.redis = redisClient; // null = use in-memory fallback
    this.fallback = new Map(); // phone -> Set<url>
  }

  _key(phone) {
    return `sent_images:${phone}`;
  }

  async add(phone, imageUrl) {
    if (this.redis) {
      try {
        await this.redis.sadd(this._key(phone), imageUrl);
        await this.redis.expire(this._key(phone), SENT_IMAGES_TTL_SECONDS);
        return;
      } catch (err) {
        console.warn('⚠️ Redis sentImagesTracker.add failed, using fallback:', err.message);
      }
    }
    if (!this.fallback.has(phone)) this.fallback.set(phone, new Set());
    this.fallback.get(phone).add(imageUrl);
  }

  async has(phone, imageUrl) {
    if (this.redis) {
      try {
        const result = await this.redis.sismember(this._key(phone), imageUrl);
        return result === 1;
      } catch (err) {
        console.warn('⚠️ Redis sentImagesTracker.has failed, using fallback:', err.message);
      }
    }
    return this.fallback.get(phone)?.has(imageUrl) ?? false;
  }

  async clear(phone) {
    if (this.redis) {
      try {
        await this.redis.del(this._key(phone));
      } catch (err) {
        console.warn('⚠️ Redis sentImagesTracker.clear failed, using fallback:', err.message);
      }
    }
    this.fallback.delete(phone);
  }

  async getAll(phone) {
    if (this.redis) {
      try {
        return await this.redis.smembers(this._key(phone));
      } catch (err) {
        console.warn('⚠️ Redis sentImagesTracker.getAll failed, using fallback:', err.message);
      }
    }
    return [...(this.fallback.get(phone) ?? [])];
  }

  // Clear all tracked images across all phones (used in tests / full reset)
  async clearAll() {
    // For in-memory fallback, just wipe the map
    this.fallback.clear();
    // Note: Redis keys have TTL-based expiry; a full wipe is not done in production
  }
}

module.exports = { RedisSentImagesTracker };
