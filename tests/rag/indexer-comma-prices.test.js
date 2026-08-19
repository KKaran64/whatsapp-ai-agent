// The RAG quality gate's price extraction was comma-blind.
//
// validateConversationQuality() flags a conversation where the bot applied a
// discount to bulkPrice instead of MRP. It found the bot's per-piece figure
// with /₹\s*(\d+(?:\.\d+)?)/, which stops at the first comma, and then read
// it with parseFloat — which would turn '4,050' into 4 even if it did match.
//
// So the gate only ever worked below ₹1,000. Above that it silently passed
// everything, and since the bot formats money with toLocaleString('en-IN'),
// every real quote of ₹1,000+ carries a comma. The check was effectively
// dead exactly on the high-value conversations it most needed to police.

const { validateConversationQuality } = require('../../rag/indexer');

// PRO LAPTOP BAG in the real catalog: bulkPrice 4500, mrpPrice 7500.
// A 10% discount off the BULK price is the violation this gate detects:
// 4500 x 0.9 = 4050, whose implied base (4050 / 0.9) is the bulk price.
const withPrice = priceText => ({
  customerMessage: 'what is the price for 50 laptop bags?',
  botResponse: `For 50 PRO LAPTOP BAG with 10% off: ${priceText} per bag. Would you like to proceed?`
});

describe('bulk-price discount detection is independent of number formatting', () => {
  test('flags the violation when written without a comma', () => {
    const result = validateConversationQuality(withPrice('₹4050'));
    expect(result.reasons).toContain('discount_applied_to_bulkprice_not_mrp');
  });

  test('flags the SAME violation when written with a comma (previously missed)', () => {
    // This is how the bot actually writes it — toLocaleString('en-IN').
    const result = validateConversationQuality(withPrice('₹4,050'));
    expect(result.reasons).toContain('discount_applied_to_bulkprice_not_mrp');
  });

  test('both formats produce identical verdicts', () => {
    const plain = validateConversationQuality(withPrice('₹4050'));
    const comma = validateConversationQuality(withPrice('₹4,050'));
    expect(comma.valid).toBe(plain.valid);
    expect(comma.reasons.sort()).toEqual(plain.reasons.sort());
  });
});

describe('correct pricing is still not flagged', () => {
  test('a 10% discount off MRP is legitimate and stays unflagged', () => {
    // 7500 MRP x 0.9 = 6750 — discounting from MRP is the correct behaviour.
    const result = validateConversationQuality(withPrice('₹6,750'));
    expect(result.reasons).not.toContain('discount_applied_to_bulkprice_not_mrp');
  });
});
