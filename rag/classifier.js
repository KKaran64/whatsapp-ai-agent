// Uses Groq to classify a conversation into outcome + metadata.

const Groq = require('groq-sdk');

const SYSTEM_PROMPT = `You are an expert sales analyst for 9 Cork Sustainable Products.
Analyze the conversation and return ONLY valid JSON with this exact shape:
{
  "outcome": "sale" | "no_sale" | "abandoned" | "in_progress",
  "saleAmount": <number in INR or 0>,
  "products": [<product names mentioned>],
  "customerType": "corporate" | "horeca" | "retail",
  "budget": <number per-piece in INR or 0>,
  "confidence": <0.0-1.0>
}
Rules:
- "sale" only if payment confirmed ("paid", "transferred", "payment done")
- "no_sale" if customer explicitly declined ("too expensive", "not interested")
- "abandoned" if customer ghosted >7 days after multiple questions
- "in_progress" if conversation is recent and ongoing
- confidence < 0.5 means you're unsure
- Return ONLY the JSON object, no markdown, no prose.`;

async function classifyConversation(messages) {
  if (!process.env.GROQ_API_KEY) {
    return defaultResult('Groq not configured');
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const conversationText = messages
    .map(m => `${m.role === 'customer' ? 'Customer' : 'You'}: ${m.content}`)
    .join('\n');

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: conversationText }
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return defaultResult('Empty response');

    const parsed = JSON.parse(content);
    return {
      outcome: parsed.outcome || 'in_progress',
      saleAmount: Number(parsed.saleAmount) || 0,
      products: Array.isArray(parsed.products) ? parsed.products : [],
      customerType: parsed.customerType || 'retail',
      budget: Number(parsed.budget) || 0,
      confidence: Number(parsed.confidence) || 0,
      needsReview: Number(parsed.confidence) < 0.5
    };
  } catch (err) {
    console.error('❌ Classifier error:', err.message);
    return defaultResult(err.message);
  }
}

function defaultResult(reason) {
  return {
    outcome: 'in_progress',
    saleAmount: 0,
    products: [],
    customerType: 'retail',
    budget: 0,
    confidence: 0,
    needsReview: true,
    error: reason
  };
}

module.exports = { classifyConversation };
