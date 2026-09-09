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


// ── Reasoning-model awareness ─────────────────────────────────────────────
//
// The Llama models this system was built on emitted an answer directly. Their
// replacements reason first: openai/gpt-oss spends a few hundred tokens on
// hidden reasoning BEFORE writing content, and those tokens come out of
// max_tokens. Budgets tuned for a non-reasoning model therefore produced
// empty completions — the router's 10-token budget classified every message
// as FALLBACK, and the responder's 80 returned four characters.
//
// So a token budget is not a property of the caller alone; it depends on the
// configured model. Both now live here, next to the model ids they belong to.

// Groq rejects this parameter on some models with a hard 400 ("`reasoning_effort`
// is not supported with this model" — verified on groq/compound-mini), so it is
// sent only where support is known. Unknown models are assumed NOT to support
// it: omitting it costs a few tokens, sending it wrongly costs every reply.
const REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT || 'low';

function supportsReasoningEffort(model) {
  return /^(openai\/gpt-oss|qwen\/)/.test(String(model || ''));
}

// Floors that leave room for a reply after reasoning. Measured: 10 tokens
// yielded empty content, 80 yielded 4 characters, 500 worked.
const TOKEN_BUDGETS = {
  ROUTER: Number(process.env.GROQ_TOKENS_ROUTER) || 150,
  RESPONDER: Number(process.env.GROQ_TOKENS_RESPONDER) || 400,
  CHAT: Number(process.env.GROQ_TOKENS_CHAT) || 800
};

/** Extra request fields for the configured model. Empty when unsupported. */
function reasoningParams(model) {
  return supportsReasoningEffort(model) ? { reasoning_effort: REASONING_EFFORT } : {};
}

module.exports = { MODELS, REASONING_EFFORT, TOKEN_BUDGETS, supportsReasoningEffort, reasoningParams };
