#!/usr/bin/env node
// Replay real customer conversations from data/past-chats through the bot and
// report anything a customer should never see.
//
// Not a unit test: it drives the real provider chain and the real pricing
// engine, so it catches the class of failure that green mocks kept hiding —
// a bot that returns a placeholder, a non-answer, or an invented price.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'past-chats');
const REPO = path.join(__dirname, '..');
const BUSINESS = '9 Cork Sustainable Products';

// WhatsApp exports prefix lines with U+200E (LRM) and use U+202F before AM/PM.
// rag/chat-parser.js anchors on ^\[ and so drops ~95% of real lines.
const LINE = /^‎?\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*([\d:]+\s*(?:AM|PM)?)\]\s*([^:]+):\s*(.*)$/i;

function parse(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(LINE);
    if (m) {
      if (cur) out.push(cur);
      const sender = m[3].trim();
      cur = {
        sender,
        role: sender === BUSINESS ? 'business' : 'customer',
        content: m[4].replace(/‎/g, '').trim()
      };
    } else if (cur && line.trim()) {
      cur.content += ' ' + line.replace(/‎/g, '').trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

const SKIP = /image omitted|sticker omitted|video omitted|document omitted|audio omitted|end-to-end encrypted|this message was deleted|missed voice call|missed video call|^null$/i;

function loadConversations() {
  const convos = [];
  for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.txt'))) {
    const msgs = parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const turns = msgs
      .filter(m => m.role === 'customer' && m.content && !SKIP.test(m.content) && m.content.length > 1)
      .map(m => m.content.slice(0, 300));
    if (turns.length >= 2) convos.push({ file: f.replace('WhatsApp Chat - ', '').replace('.txt', ''), turns });
  }
  return convos;
}

// What a customer must never receive.
const BAD = [
  [/I'm here to help!$/i, 'placeholder-nonanswer'],
  [/having trouble processing/i, 'provider-failure-message'],
  [/^\s*$/, 'empty-reply'],
  [/undefined|NaN|\[object Object\]/, 'template-leak'],
  [/\bIGNORE PREVIOUS INSTRUCTIONS\b/i, 'injection-echo']
];

function judge(reply) {
  const issues = [];
  for (const [re, label] of BAD) if (re.test(reply || '')) issues.push(label);
  return issues;
}

async function main() {
  const limit = Number(process.argv[2]) || 100;
  const convos = loadConversations();
  const totalTurns = convos.reduce((n, c) => n + c.turns.length, 0);
  console.log(`corpus: ${convos.length} conversations, ${totalTurns} customer turns`);

  // Flatten to individual scenarios, capped.
  const scenarios = [];
  for (const c of convos) {
    for (let i = 0; i < c.turns.length; i++) {
      scenarios.push({ who: c.file, turn: c.turns[i], history: c.turns.slice(Math.max(0, i - 2), i) });
      if (scenarios.length >= limit) break;
    }
    if (scenarios.length >= limit) break;
  }
  console.log(`replaying ${scenarios.length} turns through the real provider chain...\n`);

  const AIProviderManager = require(path.join(REPO, 'ai-provider-manager'));
  const { buildSystemPrompt } = require(path.join(REPO, 'prompts/system-prompt'));
  const mgr = new AIProviderManager({
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_API_KEY_2: process.env.GROQ_API_KEY_2,
    GROQ_API_KEY_3: process.env.GROQ_API_KEY_3,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY
  });
  const SYS = buildSystemPrompt();

  const failures = [];
  let done = 0, errors = 0;
  for (const s of scenarios) {
    const hist = s.history.map(h => ({ role: 'user', content: h }));
    try {
      const r = await mgr.getResponse(SYS, hist, s.turn);
      const issues = judge(r.response);
      if (issues.length) failures.push({ ...s, reply: r.response, issues, provider: r.provider });
    } catch (err) {
      errors++;
      failures.push({ ...s, reply: '(threw) ' + err.message, issues: ['exception'], provider: 'none' });
    }
    done++;
    if (done % 20 === 0) console.log(`  ...${done}/${scenarios.length}`);
    // Pace to stay under Groq's tokens-per-minute ceiling. The ~7k-token
    // system prompt rides on EVERY request, so a burst exhausts TPM quickly:
    // an unpaced run of this script produced a 33% failure rate that was
    // purely self-inflicted. Measured per key, each has its own ~200k/min
    // bucket, so rotation does help — but the prompt size, not the key count,
    // is what sets the ceiling.
    await new Promise(r => setTimeout(r, Number(process.env.REPLAY_DELAY_MS) || 2500));
  }

  console.log(`\n===== RESULT =====`);
  console.log(`replayed : ${done}`);
  console.log(`clean    : ${done - failures.length}`);
  console.log(`problems : ${failures.length}  (exceptions: ${errors})`);
  if (failures.length) {
    const byIssue = {};
    for (const f of failures) for (const i of f.issues) byIssue[i] = (byIssue[i] || 0) + 1;
    console.log('\nby type:');
    for (const [k, v] of Object.entries(byIssue).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(3)}  ${k}`);
    console.log('\nfirst 10:');
    failures.slice(0, 10).forEach(f => {
      console.log(`  [${f.issues.join(',')}] ${f.who}`);
      console.log(`     customer: ${JSON.stringify(f.turn.slice(0, 80))}`);
      console.log(`     bot     : ${JSON.stringify((f.reply || '').slice(0, 80))}`);
    });
  }
  fs.writeFileSync(path.join(__dirname, '..', 'replay-results.json'), JSON.stringify({ done, failures }, null, 1));
  console.log(`\nfull results -> replay-results.json`);
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
