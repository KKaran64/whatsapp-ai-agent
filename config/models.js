// Single source of truth for model ids, token budgets and per-model request
// params. Every call site imports from here; tests/model-config.test.js fails
// the build if a model id string is typed anywhere else.
//
// Why env overrides: Groq retired llama (2026-08-16), qwen3.6 (2026-09-14)
// and compound (2026-09-21) within six weeks; Google retired gemini-2.0-flash.
// The next retirement must be a Render env var + restart, not a deploy.
//
// Why budgets live here: openai/gpt-oss-* are reasoning models that spend
// tokens on hidden reasoning BEFORE emitting content, out of the same
// max_tokens. A budget tuned for Llama (router 10, responder 80) produced
// empty completions on gpt-oss. A budget is a property of the model, so it
// sits next to the model id.

const env = (k, d) => (process.env[k] || '').trim() || d;

const MODELS = Object.freeze({
  GROQ_CHAT:       env('GROQ_MODEL_CHAT',    'openai/gpt-oss-120b'),
  GROQ_FAST:       env('GROQ_MODEL_FAST',    'openai/gpt-oss-20b'),
  GROQ_JSON:       env('GROQ_MODEL_JSON',    'qwen/qwen3.8-27b'),
  GROQ_WHISPER:    env('GROQ_MODEL_WHISPER', 'whisper-large-v3-turbo'),
  GEMINI_CHAT:     env('GEMINI_MODEL_CHAT',  'gemini-3.6-flash'),
  GEMINI_VISION:   env('GEMINI_MODEL_VISION','gemini-2.5-flash'),
  GEMINI_VISION_LITE: env('GEMINI_MODEL_VISION_LITE', 'gemini-2.5-flash-lite'),
  CLAUDE_FALLBACK: env('CLAUDE_MODEL',       'claude-haiku-4-5'),
});

const TOKEN_BUDGETS = Object.freeze({
  ROUTER: 150,     // was 10 — gpt-oss spends ~30 reasoning tokens on "OK"
  RESPONDER: 400,  // was 80
  CHAT: 800,       // was 500
  JSON: 500,
});

// gpt-oss accepts reasoning_effort and 'low' cuts hidden reasoning ~50x.
// qwen and unknown models default to NOT sending it: groq/compound hard-400ed
// on the param, and the next model may too.
const REASONING_EFFORT_MODELS = [/^openai\/gpt-oss/];

function supportsReasoningEffort(modelId) {
  return REASONING_EFFORT_MODELS.some(re => re.test(modelId || ''));
}

function reasoningParams(modelId) {
  return supportsReasoningEffort(modelId) ? { reasoning_effort: 'low' } : {};
}

module.exports = {
  MODELS,
  TOKEN_BUDGETS,
  reasoningParams,
  supportsReasoningEffort,
  GROQ_MODELS_URL: 'https://api.groq.com/openai/v1/models',
  GEMINI_MODELS_URL: 'https://generativelanguage.googleapis.com/v1beta/models',
  ANTHROPIC_MODELS_URL: 'https://api.anthropic.com/v1/models',
};
