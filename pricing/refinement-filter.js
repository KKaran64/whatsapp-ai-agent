// Refinement filter for image selection (spec 2026-07-06).
//
// Gives the image path the same refinement-narrowing semantics the quote
// engine uses for pricing: positive refinements NARROW to matching items
// when at least one item matches (a refinement matching nothing is ignored);
// '!'-prefixed refinements always exclude; empty refinements are identity.
//
// Token matching differs from the engine's plural-only stemmer on purpose:
// exact token match always counts (so 'a5' works), and tokens ≥4 chars also
// match by prefix in either direction — 'magnetic' ↔ 'magnet' — because
// product names use both forms (SMALL MAGNETIC PLANTER, FRIDGE MAGNET
// PLANTER). The quote engine itself is deliberately NOT modified.

const PREFIX_MIN_LEN = 4;

function nameTokens(name) {
  return String(name || '').toLowerCase().split(/[\s/&\-,.]+/).filter(t => t.length >= 2);
}

function tokenMatches(refToken, nameToken) {
  if (refToken === nameToken) return true;
  if (refToken.length >= PREFIX_MIN_LEN && nameToken.length >= PREFIX_MIN_LEN) {
    return refToken.startsWith(nameToken) || nameToken.startsWith(refToken);
  }
  return false;
}

function itemMatchesToken(tokens, refToken) {
  return tokens.some(t => tokenMatches(refToken, t));
}

function filterByRefinements(items, refinements, getName = i => i.name) {
  if (!Array.isArray(items) || items.length === 0) return items || [];
  if (!Array.isArray(refinements) || refinements.length === 0) return items;

  const positive = [];
  const negative = [];
  for (const r of refinements) {
    if (typeof r !== 'string') continue;
    const t = r.trim().toLowerCase();
    if (!t) continue;
    if (t.startsWith('!')) {
      const tok = t.slice(1).trim();
      if (tok) negative.push(tok);
    } else {
      positive.push(...t.split(/\s+/).filter(x => x.length >= 2));
    }
  }

  // Negatives always exclude.
  let result = items.filter(i => {
    const tokens = nameTokens(getName(i));
    return !negative.some(n => itemMatchesToken(tokens, n));
  });

  if (positive.length === 0) return result;

  // Positives narrow — but only when at least one item matches, so a
  // use-case word ('office') can never empty the result set.
  const withHits = result.map(i => {
    const tokens = nameTokens(getName(i));
    return { item: i, hit: positive.some(p => itemMatchesToken(tokens, p)) };
  });
  const anyHit = withHits.some(w => w.hit);
  if (!anyHit) return result;
  return withHits.filter(w => w.hit).map(w => w.item);
}

// Term selection for the image path: the customer's own phrase (from the
// intent resolver) beats the category bucket; the bucket remains the
// fallback for null intent (LLM outage / no product mentioned).
function selectImageSearch(intent, resolvedCategory) {
  if (intent && intent.productQuery) {
    return {
      term: intent.productQuery,
      refinements: Array.isArray(intent.refinements) ? intent.refinements : [],
      source: 'intent'
    };
  }
  if (resolvedCategory && resolvedCategory.mongoSearch) {
    return { term: resolvedCategory.mongoSearch, refinements: [], source: 'category' };
  }
  return null;
}

module.exports = {
  filterByRefinements,
  selectImageSearch,
  // for tests
  nameTokens,
  tokenMatches
};
