// Vision Handler — v61 (Single-Brain rewrite)
//
// Stripped down to ONLY what the bot still needs:
//   - downloadImage(mediaId) — fetch WhatsApp media + decode + light compression
//   - handleImageMessage(mediaId, ...) — legacy fallback wrapper (kept so any
//     stale callsite using it doesn't crash; just returns a polite "couldn't
//     process" response). The PRIMARY image identifier is now
//     pricing/vision-identifier.js (catalog-aware Gemini Vision).
//   - getStats() — health endpoint compatibility
//
// REMOVED: SmartImageMatcher (1,100 lines), legacy provider configs for
// Together/Claude/Google Cloud/HuggingFace, local-ML pipeline, the 4-layer
// fallback chain, stats persistence to vision-stats.json. The new pipeline
// is: WhatsApp Media API → downloadImage → Gemini Vision identifier (in
// pricing/vision-identifier.js) → text pipeline.

const axios = require('axios');

// Lightweight optional compressor — gracefully skips if sharp is unavailable.
async function maybeCompress(buffer) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(buffer).metadata();
    if (meta.size && meta.size < 1024 * 1024) return { buffer, compressed: false };
    const out = await sharp(buffer).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { buffer: out, compressed: true };
  } catch {
    return { buffer, compressed: false };
  }
}

class VisionHandler {
  constructor(config = {}) {
    this.whatsappToken = config.whatsappToken;
    this.stats = { totalImages: 0, downloadFailures: 0, startedAt: new Date().toISOString() };
  }

  // Download an image from Meta's Media API.
  // Returns { base64, mimeType, sizeKB, compressed } — same shape the rest
  // of server.js expects.
  async downloadImage(mediaId) {
    if (!this.whatsappToken) throw new Error('WHATSAPP_TOKEN not configured');
    try {
      const mediaResponse = await axios.get(
        `https://graph.facebook.com/v21.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${this.whatsappToken}` }, timeout: 10000 }
      );
      const imageResponse = await axios.get(mediaResponse.data.url, {
        headers: { Authorization: `Bearer ${this.whatsappToken}` },
        responseType: 'arraybuffer',
        timeout: 15000
      });

      const original = Buffer.from(imageResponse.data);
      const mimeType = mediaResponse.data.mime_type || 'image/jpeg';
      const { buffer, compressed } = await maybeCompress(original);

      this.stats.totalImages++;
      return {
        base64: buffer.toString('base64'),
        mimeType,
        sizeKB: Math.round(buffer.length / 1024),
        compressed
      };
    } catch (err) {
      this.stats.downloadFailures++;
      throw err;
    }
  }

  // Legacy entry point — server.js still references this in the
  // /webhook-optimized path and in the rare case where the Gemini Vision
  // identifier in pricing/vision-identifier.js is unavailable. Returns a
  // safe, polite fallback so the bot never crashes.
  async handleImageMessage(mediaId, _userMessage, _phoneNumber, _conversationHistory, _systemPrompt) {
    // Try to at least download the image so we can confirm it arrived.
    try {
      await this.downloadImage(mediaId);
    } catch (err) {
      return {
        provider: 'fallback',
        response: "Sorry — I had trouble loading your image. Could you tell me which product you're interested in, or resend?",
        imageProcessed: false,
        latencyMs: 0
      };
    }
    return {
      provider: 'fallback',
      response: "Thanks for the photo! Could you let me know which product you're looking for? (e.g. coasters, diaries, planters, frames, etc.)",
      imageProcessed: true,
      latencyMs: 0
    };
  }

  getStats() {
    return {
      ...this.stats,
      primaryIdentifier: 'gemini-vision (pricing/vision-identifier.js)',
      legacyMatcherRemoved: true
    };
  }
}

module.exports = VisionHandler;
