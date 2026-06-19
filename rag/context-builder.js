// Assembles retrieved Pinecone matches into a prompt-injection string.

const DEFAULT_MAX_TOKENS = 14000;

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function formatExample(match, withOutcome = true) {
  const cm = (match.customerMessage || '').trim();
  const br = (match.botResponse || '').trim();
  const outcomeTag = withOutcome && match.outcome ? ` [${match.outcome}${match.saleAmount ? ` ₹${match.saleAmount}` : ''}]` : '';
  return `Customer: ${cm}\nResponse: ${br}${outcomeTag}`;
}

function buildSection(title, matches, maxTokens) {
  if (!matches || matches.length === 0) return '';
  let section = `\n═══ ${title} ═══\n`;
  let used = estimateTokens(section);
  for (const m of matches) {
    const example = formatExample(m);
    const cost = estimateTokens(example) + 5;
    if (used + cost > maxTokens) break;
    section += '\n' + example + '\n';
    used += cost;
  }
  return section;
}

function buildRagContext(retrievalResult, options = {}) {
  if (!retrievalResult || !retrievalResult.usedRAG) return '';
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const { customerHistory, similarConversations, productContext } = retrievalResult;
  const historyBudget = Math.floor(maxTokens * 0.25);
  const similarBudget = Math.floor(maxTokens * 0.5);
  const productBudget = Math.floor(maxTokens * 0.25);

  const parts = ['\n\n[RAG CONTEXT — Use these real past examples to inform your response]'];

  if (customerHistory?.length) parts.push(buildSection('THIS CUSTOMER\'S PAST INTERACTIONS', customerHistory, historyBudget));
  if (similarConversations?.length) parts.push(buildSection('SIMILAR SUCCESSFUL SALES', similarConversations, similarBudget));
  if (productContext?.length) parts.push(buildSection('PRODUCT REFERENCE EXAMPLES', productContext, productBudget));

  parts.push('\n[END RAG CONTEXT — Apply these patterns naturally; do NOT quote them verbatim]\n');
  return parts.join('');
}

module.exports = { buildRagContext, estimateTokens };
