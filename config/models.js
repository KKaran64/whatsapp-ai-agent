// Canonical LLM model IDs — one place, overridable without a redeploy.
//
// 2026-09-05 incident: Groq retired every Llama chat model and Google retired
// gemini-2.0-flash, both within days. Groq 404'd, Gemini 404'd, and every
// customer message fell through to "I'm having trouble processing your
// message right now". The bot was down for everything except hardcoded
// greeting templates.
//
// The outage was not the deprecation itself — that is routine and will happen
// again. It was that the model IDs were hardcoded in seven separate files
// (ai-provider-manager, optimized-bot/router-agent, optimized-bot/
// responder-agent, pricing/groq-client, rag/classifier, scripts/weekly-cron,
// rotate-keys), so there was no way to react without editing code and
// redeploying, and no single place that said which models this system runs on.
//
// Two properties matter here:
//   1. One definition. Callers import; they never write a model string.
//   2. Env-overridable. When a vendor retires a model, set the env var on
//      Render and restart — same instant-recovery lever as INTENT_RESOLVER.
//
// CHAT vs JSON is a real capability split, not a preference. As of this
// writing openai/gpt-oss-* return HTTP 400 for response_format json_object,
// while qwen and compound support it. pricing/intent-resolver.js and
// rag/classifier.js depend on JSON mode — pointing them at a chat-only model
// makes intent resolution fail silently and drop back to the regex extractor,
// which quietly disables the pricing guard. Keep the two separate.

const MODELS = {
  // General conversation — the main bot's replies.
  GROQ_CHAT: process.env.GROQ_MODEL_CHAT || 'openai/gpt-oss-120b',

  // Small/fast model for classification (optimized-bot's router).
  GROQ_FAST: process.env.GROQ_MODEL_FAST || 'openai/gpt-oss-20b',

  // MUST support response_format: { type: 'json_object' }.
  GROQ_JSON: process.env.GROQ_MODEL_JSON || 'qwen/qwen3.8-27b',

  // Gemini fallback provider.
  GEMINI_CHAT: process.env.GEMINI_MODEL_CHAT || 'gemini-3.6-flash',

  // Gemini vision (image identification).
  GEMINI_VISION: process.env.GEMINI_MODEL_VISION || 'gemini-3.6-flash'
};

module.exports = { MODELS };
