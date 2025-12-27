/**
 * Quick Fix for Image Sending Issues
 *
 * This script adds retry logic and fallback messaging to handle
 * WhatsApp image sending failures.
 *
 * Usage: Copy the functions below into your server.js/server-production.js
 */

const axios = require('axios');

// ============================================
// SOLUTION 1: Retry Logic with Exponential Backoff
// ============================================

async function sendImageWithRetry(phoneNumber, imageUrl, caption = '', maxRetries = 3) {
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[IMAGE] Attempt ${attempt}/${maxRetries}: ${imageUrl.slice(0, 50)}...`);

      const response = await axios.post(
        `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'image',
          image: {
            link: imageUrl,
            caption: caption
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000 // 15 seconds
        }
      );

      console.log(`[IMAGE] Success on attempt ${attempt}`);
      return { success: true, response: response.data };

    } catch (error) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      console.error(`[IMAGE] Attempt ${attempt} failed: ${errorMsg}`);

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.log(`[IMAGE] Retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        return {
          success: false,
          error: errorMsg,
          imageUrl: imageUrl
        };
      }
    }
  }
}

// ============================================
// SOLUTION 2: Send Image with Automatic Fallback
// ============================================

async function sendProductImageSafe(phoneNumber, product) {
  const imageUrl = product.images && product.images[0];

  if (!imageUrl) {
    // No image available, send text only
    return await sendTextMessage(phoneNumber,
      `${product.name}\n` +
      `Price: Rs ${product.price}\n\n` +
      `Contact us for images and more details!`
    );
  }

  // Try sending image with retry
  const result = await sendImageWithRetry(
    phoneNumber,
    imageUrl,
    `${product.name} - Rs ${product.price}`,
    3 // 3 retries
  );

  if (!result.success) {
    // Fallback: Send text with clickable image link
    console.log(`[IMAGE] Sending fallback text message`);

    await sendTextMessage(phoneNumber,
      `${product.name}\n\n` +
      `Price: Rs ${product.price}\n\n` +
      `View Image: ${imageUrl}\n\n` +
      `Image could not be sent automatically. Please click the link above to view the product.`
    );
  }

  return result;
}

// ============================================
// HELPER: Send Text Message
// ============================================

async function sendTextMessage(phoneNumber, text) {
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return { success: true, response: response.data };
  } catch (error) {
    console.error('[TEXT] Send failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// MONITORING: Track Success Rate
// ============================================

const imageStats = {
  sent: 0,
  failed: 0,
  retries: 0
};

// Log stats every hour
setInterval(() => {
  const total = imageStats.sent + imageStats.failed;
  const successRate = total > 0 ? (imageStats.sent / total * 100).toFixed(2) : 0;

  console.log(`[STATS] Images - Sent: ${imageStats.sent}, Failed: ${imageStats.failed}, Success Rate: ${successRate}%`);
}, 3600000); // 1 hour

module.exports = {
  sendImageWithRetry,
  sendProductImageSafe,
  sendTextMessage,
  imageStats
};
