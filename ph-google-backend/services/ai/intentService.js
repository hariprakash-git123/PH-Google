/**
 * Lightweight query-intent detection for AI answers.
 *
 * A handful of ordered patterns, not a classifier: the intent only chooses
 * how the answer is laid out (a definition, steps, a comparison, …), so a
 * wrong guess costs a slightly less apt shape, never a wrong fact. The first
 * rule that matches wins, so the more specific rules come first.
 */

const INTENTS = [
  'definition',
  'explanation',
  'how-to',
  'comparison',
  'factual',
  'list',
  'troubleshooting',
  'navigation',
  'recent'
];

const RULES = [
  // "x vs y", "difference between x and y", "x compared to y"
  [
    'comparison',
    /\b(vs\.?|versus|compared (?:to|with)|comparison|differences? between|better than)\b/i
  ],
  [
    'troubleshooting',
    /\b(error|not working|doesn'?t work|won'?t|can'?t|cannot|fail(?:s|ed|ing|ure)?|fix|issue|problem|broken|crash(?:es|ed|ing)?|troubleshoot\w*|debug\w*)\b/i
  ],
  [
    'how-to',
    /^(how (?:do|does|can|to|should|would)|how's|steps? to|guide to|tutorial)\b|\bhow to\b/i
  ],
  [
    'recent',
    /\b(latest|newest|recent(?:ly)?|today|tonight|this (?:week|month|year)|breaking|news|update[sd]?|current(?:ly)?|20[2-9]\d)\b/i
  ],
  [
    'list',
    /^(list|top \d+|best|examples? of|types? of|kinds? of|which)\b|\b(list of|examples of)\b/i
  ],
  [
    'definition',
    /^(what(?:'s| is| are| was| were)|define|definition of|meaning of|who (?:is|was|are))\b|\bmeaning$/i
  ],
  ['explanation', /^(why|explain|describe|what (?:does|do|happens|causes))\b/i],
  [
    'factual',
    /^(when|where|who|how (?:many|much|long|old|far|big|tall)|is|are|was|were|does|do|did|can|could)\b/i
  ],
  // A bare domain or "x login / website / homepage" is someone finding a site.
  [
    'navigation',
    /^[\w-]+\.(?:com|org|net|io|gov|edu|dev|in|co)\b|\b(login|sign ?in|homepage|official (?:site|website)|website|download)\b/i
  ]
];

/**
 * @param {string} query
 * @returns {string} one of INTENTS
 */
function detectIntent(query) {
  const q = String(query || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return 'factual';

  for (const [intent, pattern] of RULES) {
    if (pattern.test(q)) return intent;
  }

  // One or two bare words ("opensearch", "binary search") ask what it is.
  const words = q.split(' ');
  if (words.length <= 3) return 'definition';
  return 'explanation';
}

/** How the answer should be laid out for an intent. Read by the prompt. */
const FORMAT_GUIDANCE = {
  definition: 'Give a concise definition in one or two sentences, then at most a few key points.',
  explanation:
    'Explain it plainly in a short paragraph; add key points only if they add something.',
  'how-to': 'Give the steps in order. Put each step in key_points, in sequence.',
  comparison:
    'Say what each side is and how they differ. Put the main differences in key_points, each naming both sides.',
  factual:
    'Answer directly in one or two sentences. Use key_points only if the answer has several parts.',
  list: 'Give a one-sentence lead-in and put the items in key_points.',
  troubleshooting:
    'Name the likely cause if the sources give one, then the fixes as ordered key_points.',
  navigation:
    'Say briefly what the site or page is, from the sources. Do not guess an address that is not in them.',
  recent:
    'Answer from the sources and say how recent they are when they give dates. Do not present undated material as current.'
};

module.exports = { detectIntent, INTENTS, FORMAT_GUIDANCE };
