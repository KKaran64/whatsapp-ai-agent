/**
 * Test script for WhatsApp Media Upload API
 *
 * This tests uploading the cork photo frame image and sending it
 */

require('dotenv').config();
const { sendProductImage, getCacheStats } = require('./whatsapp-media-upload');

// Test product (Cork Photo Frame)
const photoFrame = {
  id: 'photo-001',
  name: 'Cork Photo Frame Natural',
  price: 749,
  images: ['https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg']
};

async function test() {
  console.log('='.repeat(60));
  console.log('Testing WhatsApp Media Upload API');
  console.log('='.repeat(60));

  // Replace with your test phone number
  const testPhone = process.env.TEST_PHONE_NUMBER || '919XXXXXXXXX';

  console.log(`\nTest Phone: ${testPhone}`);
  console.log(`Product: ${photoFrame.name}`);
  console.log(`Image URL: ${photoFrame.images[0]}`);
  console.log('\n' + '='.repeat(60));

  try {
    console.log('\n[TEST] Uploading and sending image...\n');

    const result = await sendProductImage(testPhone, photoFrame);

    console.log('\n' + '='.repeat(60));

    if (result.success) {
      console.log('SUCCESS!');
      console.log(`Media ID: ${result.mediaId}`);
      console.log(`Message ID: ${result.response.messages[0].id}`);
    } else {
      console.log('FAILED!');
      console.log(`Error: ${result.error}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('Cache Statistics:');
    console.log(getCacheStats());
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\nTest failed with error:', error.message);
    console.error(error.stack);
  }
}

// Run the test
if (require.main === module) {
  test().then(() => {
    console.log('\nTest complete!');
    process.exit(0);
  }).catch(error => {
    console.error('\nTest failed:', error);
    process.exit(1);
  });
}

module.exports = { test };
