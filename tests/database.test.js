const {
  updateConversationHistory,
  updateLeadQualification,
  getConversationHistory,
  getOrCreateCustomer,
  updateCustomerMetadata
} = require('../utils/database');

// Mock dependencies
jest.mock('../input-sanitizer', () => ({
  sanitizePhoneNumber: jest.fn(phone => {
    if (!phone || typeof phone !== 'string') throw new Error('Phone number required');
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(digits)) throw new Error('Invalid phone number format');
    return digits;
  })
}));

jest.mock('../config/constants', () => ({
  DATABASE: {
    CONVERSATION_HISTORY_LIMIT: 50,
    CONVERSATION_CONTEXT_LIMIT: 10
  }
}));

// Suppress console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ─── Helper: Create mock Customer model ──────────────────────────────────────

function createMockCustomerModel(overrides = {}) {
  return {
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null)
    }),
    create: jest.fn().mockResolvedValue({
      phoneNumber: '9876543210',
      metadata: { firstSeen: new Date(), lastSeen: new Date(), totalMessages: 0, source: 'whatsapp', status: 'active' }
    }),
    // Blind-index lookup helper. The real impl returns a $or filter; here it
    // returns { phoneNumber } so existing "queried by phone" assertions still
    // hold. The real phoneFilter shape is covered in phone-blind-index.test.js.
    phoneFilter: (p) => ({ phoneNumber: p }),
    ...overrides
  };
}

// ─── updateConversationHistory ───────────────────────────────────────────────

describe('updateConversationHistory', () => {
  test('calls updateOne with correct atomic operations', async () => {
    const Customer = createMockCustomerModel();
    const userMsg = { role: 'user', content: 'Hello' };
    const aiMsg = { role: 'assistant', content: 'Hi there!' };

    await updateConversationHistory(Customer, '9876543210', userMsg, aiMsg);

    expect(Customer.updateOne).toHaveBeenCalledWith(
      { phoneNumber: '9876543210' },
      expect.objectContaining({
        $push: expect.objectContaining({
          conversationHistory: expect.objectContaining({
            $each: [userMsg, aiMsg],
            $slice: -50
          })
        }),
        $set: expect.objectContaining({
          'metadata.lastSeen': expect.any(Date)
        }),
        $inc: { 'metadata.totalMessages': 2 }
      }),
      { upsert: false, runValidators: true }
    );
  });

  test('sanitizes phone number before query', async () => {
    const Customer = createMockCustomerModel();
    const { sanitizePhoneNumber } = require('../input-sanitizer');

    await updateConversationHistory(Customer, '+91-9876543210', { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });

    expect(sanitizePhoneNumber).toHaveBeenCalledWith('+91-9876543210');
  });

  test('throws DatabaseError on failure', async () => {
    const Customer = createMockCustomerModel({
      updateOne: jest.fn().mockRejectedValue(new Error('Connection lost'))
    });

    await expect(
      updateConversationHistory(Customer, '9876543210', {}, {})
    ).rejects.toThrow('Failed to update conversation history');
  });

  test('throws on invalid phone number', async () => {
    const Customer = createMockCustomerModel();

    await expect(
      updateConversationHistory(Customer, '123', {}, {})
    ).rejects.toThrow();
  });
});

// ─── updateLeadQualification ─────────────────────────────────────────────────

describe('updateLeadQualification', () => {
  test('builds dot-notation update fields', async () => {
    const Customer = createMockCustomerModel();

    await updateLeadQualification(Customer, '9876543210', {
      budget: 'high',
      occasion: 'corporate gifting',
      quantity: 100
    });

    expect(Customer.updateOne).toHaveBeenCalledWith(
      { phoneNumber: '9876543210' },
      {
        $set: {
          'leadQualification.budget': 'high',
          'leadQualification.occasion': 'corporate gifting',
          'leadQualification.quantity': 100
        }
      },
      { runValidators: true }
    );
  });

  test('throws DatabaseError on failure', async () => {
    const Customer = createMockCustomerModel({
      updateOne: jest.fn().mockRejectedValue(new Error('Write error'))
    });

    await expect(
      updateLeadQualification(Customer, '9876543210', { budget: 'high' })
    ).rejects.toThrow('Failed to update lead qualification');
  });
});

// ─── getConversationHistory ──────────────────────────────────────────────────

describe('getConversationHistory', () => {
  test('returns conversation messages with default limit', async () => {
    const messages = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' }
    ];
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ conversationHistory: messages })
      })
    });

    const result = await getConversationHistory(Customer, '9876543210');
    expect(result).toEqual(messages);
  });

  test('uses $slice with provided limit', async () => {
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ conversationHistory: [] })
      })
    });

    await getConversationHistory(Customer, '9876543210', 5);

    expect(Customer.findOne).toHaveBeenCalledWith(
      { phoneNumber: '9876543210' },
      { conversationHistory: { $slice: -5 }, _id: 0 }
    );
  });

  test('returns empty array when customer not found', async () => {
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null)
      })
    });

    const result = await getConversationHistory(Customer, '9876543210');
    expect(result).toEqual([]);
  });

  test('returns empty array on database error (graceful degradation)', async () => {
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockRejectedValue(new Error('DB timeout'))
      })
    });

    const result = await getConversationHistory(Customer, '9876543210');
    expect(result).toEqual([]);
  });

  test('uses .lean() for performance', async () => {
    const leanMock = jest.fn().mockResolvedValue(null);
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockReturnValue({ lean: leanMock })
    });

    await getConversationHistory(Customer, '9876543210');
    expect(leanMock).toHaveBeenCalled();
  });
});

// ─── getOrCreateCustomer ─────────────────────────────────────────────────────

describe('getOrCreateCustomer', () => {
  test('returns existing customer', async () => {
    const existingCustomer = { phoneNumber: '9876543210', metadata: {} };
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockResolvedValue(existingCustomer)
    });

    const result = await getOrCreateCustomer(Customer, '9876543210');
    expect(result).toBe(existingCustomer);
    expect(Customer.create).not.toHaveBeenCalled();
  });

  test('creates new customer when not found', async () => {
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockResolvedValue(null)
    });

    await getOrCreateCustomer(Customer, '9876543210');

    expect(Customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '9876543210',
        metadata: expect.objectContaining({
          source: 'whatsapp',
          status: 'active',
          totalMessages: 0
        })
      })
    );
  });

  test('sets firstSeen and lastSeen on new customer', async () => {
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockResolvedValue(null)
    });

    await getOrCreateCustomer(Customer, '9876543210');

    const createCall = Customer.create.mock.calls[0][0];
    expect(createCall.metadata.firstSeen).toBeInstanceOf(Date);
    expect(createCall.metadata.lastSeen).toBeInstanceOf(Date);
  });

  test('throws DatabaseError on create failure', async () => {
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockRejectedValue(new Error('Duplicate key'))
    });

    await expect(
      getOrCreateCustomer(Customer, '9876543210')
    ).rejects.toThrow('Failed to get or create customer');
  });

  test('sanitizes phone number', async () => {
    const { sanitizePhoneNumber } = require('../input-sanitizer');
    const Customer = createMockCustomerModel({
      findOne: jest.fn().mockResolvedValue({ phoneNumber: '919876543210' })
    });

    await getOrCreateCustomer(Customer, '+91-987-654-3210');
    expect(sanitizePhoneNumber).toHaveBeenCalledWith('+91-987-654-3210');
  });
});

// ─── updateCustomerMetadata ──────────────────────────────────────────────────

describe('updateCustomerMetadata', () => {
  test('builds dot-notation for nested metadata fields', async () => {
    const Customer = createMockCustomerModel();

    await updateCustomerMetadata(Customer, '9876543210', {
      lastSeen: new Date('2025-01-01'),
      totalMessages: 42,
      source: 'whatsapp'
    });

    expect(Customer.updateOne).toHaveBeenCalledWith(
      { phoneNumber: '9876543210' },
      {
        $set: {
          'metadata.lastSeen': new Date('2025-01-01'),
          'metadata.totalMessages': 42,
          'metadata.source': 'whatsapp'
        }
      },
      { runValidators: true }
    );
  });

  test('throws DatabaseError on failure', async () => {
    const Customer = createMockCustomerModel({
      updateOne: jest.fn().mockRejectedValue(new Error('Update failed'))
    });

    await expect(
      updateCustomerMetadata(Customer, '9876543210', { status: 'inactive' })
    ).rejects.toThrow('Failed to update customer metadata');
  });
});
