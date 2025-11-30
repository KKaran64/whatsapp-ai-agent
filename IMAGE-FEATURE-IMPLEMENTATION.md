# Image Feature Implementation Plan

## Overview
Adding bidirectional image support: bot can understand customer images AND send product images.

## Part 1: IMAGE UNDERSTANDING (Receive & Analyze)

### What customers can send:
- Product photos ("What's this product?")
- Logo images ("This is our company logo")
- Screenshots or reference images

### Implementation Steps:

1. **Download Image from WhatsApp**
   - When image message arrives, extract media ID
   - Call WhatsApp Media API to get media URL
   - Download image using access token
   - Convert to base64 for Claude API

2. **Handle Image Messages in Webhook**
   - Detect `messageType === 'image'`
   - Extract image ID and caption
   - Download and process image

3. **Claude Vision Integration**
   - Send image + text to Claude's vision API
   - Claude analyzes: product identification, logo details, etc.
   - Bot responds based on what it sees

### Use Cases:
- Customer sends product photo → "I see this is a cork coaster! We have 16 types. Which style interests you?"
- Customer sends logo → "Got it! I can see your logo clearly. We can print this on any of our products with screen printing or UV printing."
- Customer sends reference → "I see what you're looking for! Let me suggest similar cork products..."

## Part 2: IMAGE SENDING (Send Product Images)

### What bot can send:
- Product catalog images
- Specific product photos based on query
- Combo/set images

### Implementation Steps:

1. **Product Image Database**
   Create mapping of products to image URLs:
   ```javascript
   const PRODUCT_IMAGES = {
     'cork-diary-a5': 'https://your-cdn.com/images/diary-a5.jpg',
     'cork-coaster-round': 'https://your-cdn.com/images/coaster-round.jpg',
     // ... etc
   }
   ```

2. **WhatsApp Image Sending API**
   - Use WhatsApp's `/messages` endpoint with `type: 'image'`
   - Send image URL + optional caption
   - Format: `{ type: 'image', image: { link: 'url', caption: 'text' } }`

3. **Smart Image Selection**
   - When customer asks about product, bot suggests sending image
   - "Would you like to see photos of our cork diaries?"
   - Then sends relevant product image

### Requirements:
- **Image Hosting**: Need public URLs for all product images
  - Options: Cloudinary, ImgBB, Google Drive (public links), AWS S3, your website
- **Image Format**: JPG/PNG, recommended size: 800x800px to 1200x1200px
- **Naming Convention**: Consistent product names matching catalog

## Part 3: Integration with Sales Qualification

### Enhanced Qualification with Images:
```
Customer: "I need corporate gifts"
Bot: "Great! Are these for executives, team members, or clients?"
Customer: "Executives"
Bot: "For executive gifting, I'd suggest premium options. Would you like to see photos of our cork laptop bags, premium diaries, or desk organizer sets?"
Customer: "Diaries"
Bot: *Sends image of premium A5 diary*
Bot: "This is our Premium A5 Cork Diary (₹185 for 100 pcs, exclusive of GST & shipping). Perfect for C-suite gifting with your logo. Shall I send more options?"
```

## Technical Requirements

### Dependencies (already installed):
- axios (for downloading images)
- @anthropic-ai/sdk (supports vision)

### Environment Variables (already configured):
- WHATSAPP_TOKEN
- WHATSAPP_PHONE_NUMBER_ID
- ANTHROPIC_API_KEY

### New Functions Needed:
1. `downloadWhatsAppImage(mediaId)` - Download image from WhatsApp
2. `convertImageToBase64(imageBuffer)` - Convert for Claude
3. `processImageMessage(from, imageId, caption)` - Handle image messages
4. `sendWhatsAppImage(to, imageUrl, caption)` - Send images
5. `getProductImage(productName)` - Get product image URL

## Next Steps

1. ✅ Create this implementation plan
2. ⏳ Add image download function
3. ⏳ Update webhook to handle images
4. ⏳ Modify AI processing for vision
5. ⏳ Add image sending function
6. ⏳ Create product image mapping
7. ⏳ Test with sample images
8. ⏳ YOU PROVIDE: Product image URLs for catalog

## Testing Scenarios

1. Customer sends cork product photo
2. Customer sends company logo
3. Customer asks "show me diaries"
4. Customer asks "what do you have?"
5. Bot proactively suggests sending images during qualification
