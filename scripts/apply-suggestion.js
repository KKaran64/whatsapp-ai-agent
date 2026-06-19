#!/usr/bin/env node
// Apply approved auto-fix suggestions to system-prompt.js.
// Reads latest report from data/reports/, applies fixes flagged autoApply: true,
// commits and pushes for Render to deploy.
//
// Uses execFileSync (NOT exec) to avoid shell injection risks.
//
// Usage: node scripts/apply-suggestion.js [--report=path] [--dry-run]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'system-prompt.js');
const REPO_ROOT = path.join(__dirname, '..');

function findLatestReport() {
  const dir = path.join(REPO_ROOT, 'data', 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('weekly-')).sort().reverse();
  return files[0] ? path.join(dir, files[0]) : null;
}

function applyTextAddition(promptText, addition, marker) {
  const anchor = 'REMEMBER: You KNOW all products';
  const anchorIdx = promptText.lastIndexOf(anchor);
  if (anchorIdx === -1) {
    console.warn('⚠️ Anchor not found in system prompt — refusing to modify');
    return null;
  }
  return promptText.slice(0, anchorIdx) +
    `\n[AUTO-APPLIED FIX ${marker}]\n${addition}\n\n` +
    promptText.slice(anchorIdx);
}

function gitCommitAndPush(message) {
  execFileSync('git', ['add', 'prompts/system-prompt.js'], { cwd: REPO_ROOT });
  execFileSync('git', ['commit', '-m', message], { cwd: REPO_ROOT });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO_ROOT });
}

function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const reportPath = (args.find(a => a.startsWith('--report=')) || '').split('=')[1] || findLatestReport();

  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error('❌ No report file found.');
    process.exit(1);
  }

  console.log(`📄 Loading report: ${path.basename(reportPath)}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const autoFixes = (report.topIssues || []).filter(i => i.autoApply);

  if (autoFixes.length === 0) {
    console.log('No auto-apply fixes in this report.');
    process.exit(0);
  }

  console.log(`Found ${autoFixes.length} auto-fix(es):`);
  for (const [i, fix] of autoFixes.entries()) {
    console.log(`  ${i + 1}. ${fix.issue} → ${fix.suggestedFix}`);
  }

  let prompt = fs.readFileSync(PROMPT_FILE, 'utf-8');
  const date = new Date().toISOString().split('T')[0];

  for (const fix of autoFixes) {
    const addition = `\n# Auto-fix (${date}): ${fix.issue}\n# Suggested behavior: ${fix.suggestedFix}\n`;
    const next = applyTextAddition(prompt, addition, `${date}-${autoFixes.indexOf(fix) + 1}`);
    if (next) prompt = next;
  }

  if (dryRun) {
    console.log('\n--- Modified prompt preview (dry-run) ---');
    const idx = prompt.indexOf('AUTO-APPLIED');
    console.log(prompt.substring(idx, idx + 500));
    process.exit(0);
  }

  fs.writeFileSync(PROMPT_FILE, prompt);

  try {
    gitCommitAndPush(`auto-fix(rag): apply ${autoFixes.length} suggestions from ${date}`);
    console.log('✅ Applied, committed, and pushed.');
  } catch (err) {
    console.error('❌ Git operations failed:', err.message);
    process.exit(1);
  }
}

run();
