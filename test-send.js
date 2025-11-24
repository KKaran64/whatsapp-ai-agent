require('dotenv').config();
const axios = require('axios');

async function sendTestMessage() {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: '917696234000',
        type: 'text',
        text: {
          body: 'Hello! This is your WhatsApp-Claude sales assistant. I am here to help you with product inquiries. Try asking me something!'
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Message sent successfully!');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error sending message:');
    console.error(error.response?.data || error.message);
  }
}

sendTestMessage();
