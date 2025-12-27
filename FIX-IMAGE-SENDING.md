# Fix WhatsApp Image Sending Issues

## Problem
WhatsApp bot says "Let me show you our cork photo frames!" but the image doesn't send, followed by "It seems the image didn't come through."

## Root Causes

The image sending can fail due to:
1. **Slow image server response** - homedecorzstore.com takes too long to respond
2. **WhatsApp API timeout** - Facebook's API has strict timeout limits (5-10 seconds)
3. **Image size** - Images over 5MB may fail
4. **Image format issues** - Some URLs may not be directly accessible by WhatsApp servers
5. **SSL certificate issues** - HTTPS validation failures

## Solutions

### Solution 1: Add Retry Logic with Exponential Backoff (RECOMMENDED)

Add automatic retry when image sending fails.

**Location:** server.js or server-production.js

Find the image sending function and wrap it with retry logic:

```javascript
async function sendImageWithRetry(phoneNumber, imageUrl, caption, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[IMAGE SEND] Attempt ${attempt}/${maxRetries} for ${imageUrl}`);
      
      const response = await axios.post(
        `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'image',
          image: {
            link: imageUrl,
            caption: caption || ''
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000 // 15 second timeout
        }
      );
      
      console.log(`[IMAGE SEND] ✅ Success on attempt ${attempt}`);
      return { success: true, response };
      
    } catch (error) {
      console.error(`[IMAGE SEND] ❌ Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
        console.log(`[IMAGE SEND] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`[IMAGE SEND] All ${maxRetries} attempts failed`);
        return { success: false, error: error.message };
      }
    }
  }
}
```

**Usage:**
```javascript
const result = await sendImageWithRetry(
  customerPhone,
  'https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg',
  'Cork Photo Frame Natural - ₹749'
);

if (!result.success) {
  // Fallback: Send text description instead
  await sendTextMessage(customerPhone, 
    'Cork Photo Frame Natural\n' +
    'Price: ₹749\n' +
    'Image: https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg\n\n' +
    'View product: https://homedecorzstore.com/product/cork-photo-frame/'
  );
}
```

### Solution 2: Pre-cache Images on CDN/S3

Upload all product images to a fast, reliable CDN and update the database.

**Step 1: Upload images to Cloudinary/ImgBB/S3**

```bash
# Example using Cloudinary
npm install cloudinary

# Upload script
node << 'SCRIPT'
const cloudinary = require('cloudinary').v2;
const db = require('./product-image-database.json');
const fs = require('fs');

cloudinary.config({
  cloud_name: 'YOUR_CLOUD_NAME',
  api_key: 'YOUR_API_KEY',
  api_secret: 'YOUR_API_SECRET'
});

async function uploadImages() {
  for (const categoryKey in db.categories) {
    for (const product of db.categories[categoryKey].products) {
      for (let i = 0; i < product.images.length; i++) {
        const imageUrl = product.images[i];
        try {
          const result = await cloudinary.uploader.upload(imageUrl, {
            folder: '9cork',
            public_id: product.id + '_' + i
          });
          product.images[i] = result.secure_url; // Fast CDN URL
          console.log(`✅ Uploaded: ${product.name} image ${i+1}`);
        } catch (error) {
          console.error(`❌ Failed: ${product.name} image ${i+1}:`, error.message);
        }
      }
    }
  }
  
  fs.writeFileSync('./product-image-database.json', JSON.stringify(db, null, 2));
  console.log('\n✅ All images uploaded to CDN!');
}

uploadImages();
SCRIPT
```

**Benefits:**
- ✅ Much faster image loading
- ✅ 99.9% uptime guarantee
- ✅ Automatic image optimization
- ✅ HTTPS by default

### Solution 3: Use WhatsApp Media Upload API (BEST FOR LARGE SCALE)

Instead of using image URLs, upload images to WhatsApp's servers first.

```javascript
async function uploadImageToWhatsApp(imageUrl) {
  // Step 1: Download image
  const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  const imageBuffer = Buffer.from(imageResponse.data);
  
  // Step 2: Upload to WhatsApp
  const formData = new FormData();
  formData.append('file', imageBuffer, { filename: 'product.jpg' });
  formData.append('messaging_product', 'whatsapp');
  
  const uploadResponse = await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`,
    formData,
    {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        ...formData.getHeaders()
      }
    }
  );
  
  return uploadResponse.data.id; // WhatsApp media ID
}

async function sendImageByMediaId(phoneNumber, mediaId, caption) {
  await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: {
        id: mediaId, // Use media ID instead of URL
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
}

// Usage
const mediaId = await uploadImageToWhatsApp('https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg');
await sendImageByMediaId(customerPhone, mediaId, 'Cork Photo Frame Natural - ₹749');
```

**Benefits:**
- ✅ Images load instantly (already on WhatsApp servers)
- ✅ No timeout issues
- ✅ Can cache media IDs for reuse

### Solution 4: Quick Fix - Add Fallback Message

Simplest solution: Always send image URL as text backup.

```javascript
async function sendProductImage(phone, product) {
  try {
    // Try sending image
    await sendWhatsAppImage(phone, product.images[0], product.name);
  } catch (error) {
    // Fallback: Send text with image link
    await sendTextMessage(phone, 
      `📸 ${product.name}\n\n` +
      `Price: ₹${product.price}\n\n` +
      `View image: ${product.images[0]}\n\n` +
      `This is a high-quality cork product from ${product.source}`
    );
  }
}
```

## Recommended Implementation Order

1. **Immediate Fix:** Add Solution 4 (fallback message) - 5 minutes
2. **Short-term:** Implement Solution 1 (retry logic) - 30 minutes
3. **Long-term:** Use Solution 2 (CDN) or Solution 3 (WhatsApp Media API) - 2-4 hours

## Testing

Test the fix with:
```bash
# Send test message
curl -X POST https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages \
  -H "Authorization: Bearer ${WHATSAPP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "YOUR_PHONE",
    "type": "image",
    "image": {
      "link": "https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg",
      "caption": "Cork Photo Frame Test"
    }
  }'
```

## Monitoring

Add logging to track image send success rate:

```javascript
let imageStats = {
  sent: 0,
  failed: 0,
  retries: 0
};

// Log every hour
setInterval(() => {
  console.log(`[IMAGE STATS] Sent: ${imageStats.sent}, Failed: ${imageStats.failed}, Success Rate: ${(imageStats.sent/(imageStats.sent+imageStats.failed)*100).toFixed(2)}%`);
}, 3600000);
```
