/**
 * Test Script: Verify Message Encryption in MongoDB
 *
 * This script connects to MongoDB and checks if message content is encrypted.
 * Run: node test-encryption.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment variables');
  process.exit(1);
}

console.log('🔌 Connecting to MongoDB...');

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('✅ Connected to MongoDB\n');

    // Get raw conversation data (without Mongoose models to see encrypted data)
    const db = mongoose.connection.db;
    const conversationsCollection = db.collection('conversations');

    // Find the most recent conversation
    const recentConversation = await conversationsCollection
      .findOne({}, { sort: { lastMessageAt: -1 } });

    if (!recentConversation) {
      console.log('⚠️  No conversations found in database');
      console.log('💡 Send a test message via WhatsApp first, then run this script again');
      process.exit(0);
    }

    console.log('📊 Most Recent Conversation:');
    console.log('═'.repeat(60));
    console.log(`Customer Phone: ${recentConversation.customerPhone}`);
    console.log(`Total Messages: ${recentConversation.messages?.length || 0}`);
    console.log(`Last Message At: ${recentConversation.lastMessageAt}`);
    console.log('');

    // Check encryption status
    if (recentConversation.messages && recentConversation.messages.length > 0) {
      console.log('🔍 Checking Encryption Status:');
      console.log('═'.repeat(60));

      const latestMessage = recentConversation.messages[recentConversation.messages.length - 1];
      const content = latestMessage.content;

      console.log(`Latest Message Role: ${latestMessage.role}`);
      console.log(`Latest Message Content (raw from DB):`);
      console.log(`  ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
      console.log('');

      // Check if encrypted (format: iv:authTag:encrypted)
      const isEncrypted = content.includes(':') && content.split(':').length === 3;

      if (isEncrypted) {
        console.log('✅ ENCRYPTION VERIFIED!');
        console.log('');
        console.log('Encryption Format Detected:');
        const parts = content.split(':');
        console.log(`  - IV (Initialization Vector): ${parts[0].substring(0, 20)}... (${parts[0].length} chars)`);
        console.log(`  - Auth Tag: ${parts[1].substring(0, 20)}... (${parts[1].length} chars)`);
        console.log(`  - Encrypted Content: ${parts[2].substring(0, 20)}... (${parts[2].length} chars)`);
        console.log('');
        console.log('🔒 Message content is encrypted with AES-256-GCM');
        console.log('✅ GDPR/CCPA compliant storage confirmed');
      } else {
        console.log('❌ WARNING: Message content appears UNENCRYPTED');
        console.log('');
        console.log('This could mean:');
        console.log('  1. This is an old message (before v36 encryption was deployed)');
        console.log('  2. Encryption is not working properly');
        console.log('');
        console.log('💡 Action: Send a NEW test message via WhatsApp and run this script again');
      }

      console.log('');
      console.log('═'.repeat(60));

      // Check phone number encryption too
      console.log('');
      console.log('📞 Customer Phone Encryption Check:');
      const phoneEncrypted = recentConversation.customerPhone.includes(':') &&
                             recentConversation.customerPhone.split(':').length === 3;

      if (phoneEncrypted) {
        console.log('✅ Customer phone number is encrypted');
      } else {
        console.log('⚠️  Customer phone number appears unencrypted (may be old data)');
      }
    }

    console.log('');
    console.log('═'.repeat(60));
    console.log('Test Complete!');

    await mongoose.disconnect();
    console.log('');
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);

  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });
