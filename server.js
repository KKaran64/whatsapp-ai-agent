require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());

// Configuration - Replace these with your actual values
const CONFIG = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || 'your_whatsapp_access_token',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || 'your_phone_number_id',
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'your_verify_token',
  PORT: process.env.PORT || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'your_anthropic_api_key'
};

// Webhook verification (required by Meta)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === CONFIG.VERIFY_TOKEN) {
      console.log('Webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Receive WhatsApp messages
app.post('/webhook', async (req, res) => {
  console.log('Incoming webhook:', JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (messages && messages[0]) {
      const message = messages[0];
      const from = message.from; // Customer's phone number
      const messageBody = message.text?.body;
      const messageType = message.type;

      console.log(`Message from ${from}: ${messageBody}`);

      // Only process text messages
      if (messageType === 'text' && messageBody) {
        // Send typing indicator
        await sendTypingIndicator(from);

        // Process message with Claude Code agent
        const agentResponse = await processWithClaudeAgent(messageBody, from);

        // Send response back to customer
        await sendWhatsAppMessage(from, agentResponse);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
});

// Process message with Claude Code agent
async function processWithClaudeAgent(message, customerPhone) {
  try {
    console.log('Processing with Claude agent...');

    // Invoke Claude Code CLI with the whatsapp-sales-qualifier agent
    const prompt = `Customer WhatsApp message from ${customerPhone}: "${message}"`;

    // Using Claude API directly (more reliable for production)
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        system: `You are a WhatsApp sales assistant. Be friendly, professional, and helpful. Keep responses concise (2-3 sentences max) as they're being sent via WhatsApp. Your goal is to:
1. Greet customers warmly
2. Understand their product needs
3. Provide pricing and product information
4. Qualify leads by asking relevant questions
5. Guide them toward making a purchase`,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CONFIG.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const agentResponse = response.data.content[0].text;
    console.log('Agent response:', agentResponse);
    return agentResponse;

  } catch (error) {
    console.error('Error invoking Claude agent:', error.response?.data || error.message);
    return "Sorry, I'm having trouble processing your request right now. Please try again in a moment.";
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, text) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Message sent successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

// Send typing indicator
async function sendTypingIndicator(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: '...' } // Simple typing simulation
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Error sending typing indicator:', error.message);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(CONFIG.PORT, () => {
  console.log(`WhatsApp-Claude bridge server running on port ${CONFIG.PORT}`);
  console.log(`Webhook URL: http://your-domain.com/webhook`);
});
