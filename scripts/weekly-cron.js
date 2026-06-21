// Monday 9 AM IST analysis: pull last 7 days, summarize via Groq, send WhatsApp report.

const axios = require('axios');
const Groq = require('groq-sdk');
const Conversation = require('../models/Conversation');
const { detectOutcome } = require('../rag/outcome-detector');

const ANALYSIS_PROMPT = `You are a sales operations analyst for 9 Cork Sustainable Products WhatsApp bot.
Analyze the conversations below and return ONLY valid JSON:
{
  "totalConversations": <N>,
  "salesClosed": <N>,
  "totalSaleValue": <INR>,
  "conversionRate": <0-100>,
  "topWins": [<3-5 short bullet strings>],
  "topIssues": [
    {"issue": "<one-liner>", "affected": <N>, "suggestedFix": "<short>", "autoApply": <bool>}
  ],
  "learnedThisWeek": <count>
}
Mark autoApply: true only for trivial copy/price-tier example additions.
Mark autoApply: false for structural sales-flow changes.`;

async function runWeeklyAnalysis(config) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const conversations = await Conversation.find({
    updatedAt: { $gte: sevenDaysAgo }
  }).lean();

  console.log(`📊 Weekly analysis: ${conversations.length} conversations`);

  let tagged = 0;
  for (const conv of conversations) {
    if (conv.outcome === 'in_progress' && conv.messages) {
      const detection = detectOutcome(conv.messages);
      if (detection.outcome !== 'in_progress' && detection.confidence > 0.6) {
        await Conversation.updateOne(
          { _id: conv._id },
          { outcome: detection.outcome, outcomeAmount: detection.saleAmount, outcomeDetectedAt: new Date() }
        );
        tagged++;
      }
    }
  }
  console.log(`   Tagged ${tagged} outcomes`);

  const sample = conversations.slice(0, 100).map(c => ({
    outcome: c.outcome,
    amount: c.outcomeAmount,
    messages: (c.messages || []).slice(0, 10).map(m => `${m.role}: ${(m.content || '').substring(0, 200)}`).join(' | ')
  }));

  const groq = new Groq({ apiKey: config.GROQ_API_KEY });
  let report;
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: JSON.stringify(sample) }
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    });
    report = JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error('❌ Analysis failed:', err.message);
    return;
  }

  const lines = [
    '📊 9 CORK BOT — WEEKLY REPORT',
    '',
    `CONVERSATIONS: ${report.totalConversations}`,
    `SALES: ${report.salesClosed} (₹${(report.totalSaleValue || 0).toLocaleString('en-IN')})`,
    `CONVERSION: ${(report.conversionRate || 0).toFixed(1)}%`,
    '',
    '🟢 TOP WINS:',
    ...((report.topWins || []).map(w => `• ${w}`)),
    '',
    '🔴 TOP ISSUES:'
  ];

  let autoApplyCount = 0;
  for (const [i, issue] of (report.topIssues || []).entries()) {
    lines.push(`${i + 1}. ${issue.issue} (${issue.affected})`);
    lines.push(`   Fix: ${issue.suggestedFix}`);
    if (issue.autoApply) autoApplyCount++;
  }

  if (autoApplyCount > 0) {
    lines.push('');
    lines.push(`🔧 ${autoApplyCount} fixes ready to auto-apply.`);
    lines.push(`   Reply "yes apply" to confirm.`);
  }

  const messageText = lines.join('\n');

  if (config.ADMIN_WHATSAPP_NUMBER) {
    const token = config.WHATSAPP_TOKEN.replace(/\s/g, '');
    try {
      await axios.post(
        `https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: config.ADMIN_WHATSAPP_NUMBER,
          type: 'text',
          text: { body: messageText.substring(0, 4000) }
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      console.log('✅ Weekly report sent to admin');
    } catch (err) {
      console.error('❌ Failed to send report:', err.response?.data || err.message);
    }
  }

  const fs = require('fs');
  const path = require('path');
  const reportDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const fname = `weekly-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(path.join(reportDir, fname), JSON.stringify({ ...report, generatedAt: new Date() }, null, 2));
}

module.exports = { runWeeklyAnalysis };

if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await runWeeklyAnalysis(process.env);
    await mongoose.disconnect();
  })().catch(err => { console.error(err); process.exit(1); });
}
