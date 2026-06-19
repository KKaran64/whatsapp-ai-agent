// Rule-based outcome detection. No AI — fast and deterministic.

const SALE_KEYWORDS = /\b(paid|payment done|transferred|sent the money|transaction complete|done payment)\b/i;
const NO_SALE_KEYWORDS = /\b(too expensive|too costly|not interested|will think|maybe later|cant afford|sorry)\b/i;
const ABANDONED_DAYS = 7;
const AMOUNT_REGEX = /₹\s*([\d,]+)|rs\.?\s*([\d,]+)|inr\s*([\d,]+)/i;

function detectOutcome(messages) {
  if (!messages || messages.length === 0) {
    return { outcome: 'in_progress', confidence: 0 };
  }

  const sorted = [...messages].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const lastMsg = sorted[0];
  const lastTimestamp = lastMsg.timestamp || Date.now();
  const daysSinceLast = (Date.now() - lastTimestamp) / (1000 * 60 * 60 * 24);

  const recentCustomer = sorted.filter(m => m.role === 'customer').slice(0, 5);
  for (const msg of recentCustomer) {
    if (SALE_KEYWORDS.test(msg.content)) {
      let saleAmount = 0;
      for (const m of sorted) {
        if (m.role === 'agent' || m.role === 'business') {
          const match = m.content.match(AMOUNT_REGEX);
          if (match) {
            saleAmount = parseInt((match[1] || match[2] || match[3]).replace(/,/g, ''));
            break;
          }
        }
      }
      return { outcome: 'sale', confidence: 0.9, saleAmount };
    }
    if (NO_SALE_KEYWORDS.test(msg.content)) {
      return { outcome: 'no_sale', confidence: 0.7, saleAmount: 0 };
    }
  }

  if (daysSinceLast > ABANDONED_DAYS && messages.length >= 2) {
    return { outcome: 'abandoned', confidence: 0.8, saleAmount: 0 };
  }

  return { outcome: 'in_progress', confidence: 0.5, saleAmount: 0 };
}

module.exports = { detectOutcome };
