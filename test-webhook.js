const axios = require('axios');

// Simulate a WhatsApp webhook message
const testWebhook = async () => {
  const webhookPayload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: '1234567890', // Test phone number
            id: 'test_message_' + Date.now(),
            timestamp: Date.now(),
            type: 'text',
            text: {
              body: 'Hi, do you have cork coasters?'
            }
          }]
        }
      }]
    }]
  };

  try {
    console.log('📤 Sending test message to webhook...');
    console.log('Message:', webhookPayload.entry[0].changes[0].value.messages[0].text.body);

    const response = await axios.post('http://localhost:3000/webhook', webhookPayload);

    console.log('✅ Webhook accepted the message!');
    console.log('Response status:', response.status);

    console.log('\n⏳ Message is now being processed in the queue...');
    console.log('💡 Check the server logs to see the processing in real-time!');
    console.log('💡 The bot will try to send a response via WhatsApp API (may fail without real setup)');

  } catch (error) {
    console.error('❌ Error sending webhook:', error.message);
  }
};

testWebhook();
