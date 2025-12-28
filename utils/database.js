// Database Utility Functions
// Optimized database operations with atomic updates

const { DatabaseError } = require('../errors/AppError');
const { DATABASE } = require('../config/constants');
const { sanitizePhoneNumber } = require('../input-sanitizer');

/**
 * Atomically update customer conversation history
 * Optimized to avoid loading entire document
 *
 * @param {Model} Customer - Mongoose Customer model
 * @param {string} phoneNumber - Customer phone number
 * @param {Object} userMessage - User message object
 * @param {Object} aiMessage - AI response message object
 * @returns {Promise<Object>} Update result
 */
async function updateConversationHistory(Customer, phoneNumber, userMessage, aiMessage) {
  try {
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    const result = await Customer.updateOne(
      { phoneNumber: sanitizedPhone },
      {
        $push: {
          conversationHistory: {
            $each: [userMessage, aiMessage],
            $slice: -DATABASE.CONVERSATION_HISTORY_LIMIT  // Keep only last N messages
          }
        },
        $set: {
          'metadata.lastSeen': new Date()
        },
        $inc: {
          'metadata.totalMessages': 2
        }
      },
      {
        upsert: false,  // Don't create if doesn't exist
        runValidators: true
      }
    );

    return result;
  } catch (error) {
    throw new DatabaseError(`Failed to update conversation history: ${error.message}`, {
      phoneNumber,
      operation: 'updateConversationHistory'
    });
  }
}

/**
 * Atomically update lead qualification data
 *
 * @param {Model} Customer - Mongoose Customer model
 * @param {string} phoneNumber - Customer phone number
 * @param {Object} qualificationData - Qualification fields to update
 * @returns {Promise<Object>} Update result
 */
async function updateLeadQualification(Customer, phoneNumber, qualificationData) {
  try {
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    // Build update object with dot notation for nested fields
    const updateFields = {};
    Object.keys(qualificationData).forEach(key => {
      updateFields[`leadQualification.${key}`] = qualificationData[key];
    });

    const result = await Customer.updateOne(
      { phoneNumber: sanitizedPhone },
      {
        $set: updateFields
      },
      {
        runValidators: true
      }
    );

    return result;
  } catch (error) {
    throw new DatabaseError(`Failed to update lead qualification: ${error.message}`, {
      phoneNumber,
      operation: 'updateLeadQualification'
    });
  }
}

/**
 * Get conversation history with proper pagination
 * Returns only last N messages for AI context
 *
 * @param {Model} Customer - Mongoose Customer model
 * @param {string} phoneNumber - Customer phone number
 * @param {number} limit - Number of recent messages to retrieve
 * @returns {Promise<Array>} Conversation messages
 */
async function getConversationHistory(Customer, phoneNumber, limit = DATABASE.CONVERSATION_CONTEXT_LIMIT) {
  try {
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    const customer = await Customer.findOne(
      { phoneNumber: sanitizedPhone },
      {
        conversationHistory: { $slice: -limit },  // Get last N messages
        _id: 0  // Don't need ID
      }
    ).lean();  // Return plain JavaScript object (faster)

    return customer?.conversationHistory || [];
  } catch (error) {
    console.warn('⚠️  Database query failed, returning empty history:', error.message);
    return [];  // Graceful degradation
  }
}

/**
 * Get or create customer with sanitized data
 *
 * @param {Model} Customer - Mongoose Customer model
 * @param {string} phoneNumber - Customer phone number
 * @returns {Promise<Object>} Customer document
 */
async function getOrCreateCustomer(Customer, phoneNumber) {
  try {
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    let customer = await Customer.findOne({ phoneNumber: sanitizedPhone });

    if (!customer) {
      customer = await Customer.create({
        phoneNumber: sanitizedPhone,
        metadata: {
          firstSeen: new Date(),
          lastSeen: new Date(),
          totalMessages: 0,
          source: 'whatsapp',
          status: 'active'
        }
      });

      console.log(`✅ Created new customer: ${sanitizedPhone}`);
    }

    return customer;
  } catch (error) {
    throw new DatabaseError(`Failed to get or create customer: ${error.message}`, {
      phoneNumber,
      operation: 'getOrCreateCustomer'
    });
  }
}

/**
 * Bulk update customer metadata (for analytics)
 *
 * @param {Model} Customer - Mongoose Customer model
 * @param {string} phoneNumber - Customer phone number
 * @param {Object} metadata - Metadata fields to update
 * @returns {Promise<Object>} Update result
 */
async function updateCustomerMetadata(Customer, phoneNumber, metadata) {
  try {
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    const updateFields = {};
    Object.keys(metadata).forEach(key => {
      updateFields[`metadata.${key}`] = metadata[key];
    });

    const result = await Customer.updateOne(
      { phoneNumber: sanitizedPhone },
      { $set: updateFields },
      { runValidators: true }
    );

    return result;
  } catch (error) {
    throw new DatabaseError(`Failed to update customer metadata: ${error.message}`, {
      phoneNumber,
      operation: 'updateCustomerMetadata'
    });
  }
}

module.exports = {
  updateConversationHistory,
  updateLeadQualification,
  getConversationHistory,
  getOrCreateCustomer,
  updateCustomerMetadata
};
