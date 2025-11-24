require('dotenv').config();
const mongoose = require('mongoose');
const Customer = require('./models/Customer');
const Conversation = require('./models/Conversation');

const checkDatabase = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log('✅ Connected to MongoDB\n');

    // Check customers
    const customers = await Customer.find();
    console.log(`📊 Total Customers: ${customers.length}`);
    if (customers.length > 0) {
      console.log('Latest customers:');
      customers.slice(-3).forEach(c => {
        console.log(`  - Phone: ${c.phoneNumber}, Created: ${c.createdAt}`);
      });
    }

    console.log('');

    // Check conversations
    const conversations = await Conversation.find();
    console.log(`💬 Total Conversations: ${conversations.length}`);
    if (conversations.length > 0) {
      console.log('Latest conversations:');
      conversations.slice(-3).forEach(c => {
        console.log(`  - Customer: ${c.customerPhone}`);
        console.log(`  - Messages: ${c.messages.length}`);
        console.log(`  - Last message: ${c.lastMessageAt}`);
        if (c.messages.length > 0) {
          c.messages.forEach(m => {
            console.log(`    ${m.role}: ${m.content.substring(0, 50)}...`);
          });
        }
      });
    }

    await mongoose.connection.close();
    console.log('\n✅ Done');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

checkDatabase();
