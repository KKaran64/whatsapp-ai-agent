// Voice Message Handler — v60
//
// When a WhatsApp customer sends a voice note (audio message), this module:
//   1. Downloads the .ogg audio file via Meta's Media API
//   2. Sends it to Groq's Whisper API for transcription
//   3. Returns the text — which then flows through the normal text-message
//      processing path (intent extraction, quote engine, LLM, etc.)
//
// Groq's whisper-large-v3-turbo is fast (~500ms for 10s audio) and accurate
// for English + many regional languages including Hindi/Hinglish — perfect
// for the Indian B2B WhatsApp customer base.

const axios = require('axios');
const FormData = require('form-data');

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

// Collect all configured Groq API keys for failover (same pattern as embed.js)
function collectGroqKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

// Download audio bytes from WhatsApp Media API (same flow vision-handler uses)
async function downloadAudio(mediaId, whatsappToken) {
  const mediaResponse = await axios.get(
    `https://graph.facebook.com/v21.0/${mediaId}`,
    { headers: { 'Authorization': `Bearer ${whatsappToken}` }, timeout: 10000 }
  );

  const audioResponse = await axios.get(mediaResponse.data.url, {
    headers: { 'Authorization': `Bearer ${whatsappToken}` },
    responseType: 'arraybuffer',
    timeout: 15000
  });

  return {
    buffer: Buffer.from(audioResponse.data),
    mimeType: mediaResponse.data.mime_type || 'audio/ogg'
  };
}

// Transcribe an audio buffer via Groq Whisper, with multi-key failover
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  const keys = collectGroqKeys();
  if (keys.length === 0) {
    throw new Error('No GROQ_API_KEY configured — cannot transcribe audio');
  }

  // WhatsApp voice notes are typically .ogg with opus codec
  const filename = mimeType.includes('mp3') ? 'audio.mp3'
    : mimeType.includes('mpeg') ? 'audio.mpeg'
    : mimeType.includes('wav') ? 'audio.wav'
    : mimeType.includes('m4a') ? 'audio.m4a'
    : 'audio.ogg';

  const errors = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      const form = new FormData();
      form.append('file', audioBuffer, { filename, contentType: mimeType });
      form.append('model', WHISPER_MODEL);
      // Auto-detect language. For multilingual support (Hindi-English), this
      // works well — Whisper is strong at code-switching.
      form.append('response_format', 'json');

      const response = await axios.post(GROQ_TRANSCRIBE_URL, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${keys[i]}`
        },
        timeout: 20000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const text = (response.data?.text || '').trim();
      if (!text) throw new Error('Empty transcription returned');
      return text;
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      errors.push(`key#${i + 1}: ${msg.substring(0, 80)}`);
    }
  }
  throw new Error(`All ${keys.length} Groq keys failed: ${errors.join(' | ')}`);
}

// Main entry point — handle a WhatsApp audio message end-to-end.
// Returns the transcribed text, or null on failure (caller should send
// a polite "I couldn't hear that, please type" message).
async function handleVoiceMessage(mediaId, whatsappToken) {
  try {
    console.log(`🎤 Voice note received (mediaId=${mediaId.substring(0, 16)}...) — downloading`);
    const { buffer, mimeType } = await downloadAudio(mediaId, whatsappToken);
    console.log(`🎤 Downloaded ${(buffer.length / 1024).toFixed(1)} KB ${mimeType} — transcribing via Groq Whisper`);

    const transcribed = await transcribeAudio(buffer, mimeType);
    console.log(`🎤 Transcribed: "${transcribed.substring(0, 100)}${transcribed.length > 100 ? '...' : ''}"`);
    return transcribed;
  } catch (err) {
    console.error('❌ Voice transcription failed:', err.message);
    return null;
  }
}

module.exports = { handleVoiceMessage, transcribeAudio, downloadAudio };
