const { parseQuery } = require('../opensearch/queryParser');
const { meaningfulWords } = require('../external/resultRelevance');

/**
 * What a News search is about.
 *
 * On the News tab some words say what kind of result is wanted, not what it
 * is about: "python release news", "latest iphone", "breaking headlines on
 * the election". Searched for as words, they match almost every article —
 * "news" is in the navigation of most news pages — so an article on any
 * subject qualifies through them. They are left out of the topic. They are
 * kept when nothing else is left ("news" alone), and wherever they are part
 * of what was typed precisely: inside quotes, after an operator, or negated.
 */
const NEWS_WORDS = new Set(['news', 'latest', 'breaking', 'headline', 'headlines']);

/**
 * @param {string} query  as typed
 * @returns {string} the query without its news-intent words, or as typed
 *          when they are all it holds
 */
function newsTopic(query) {
  const text = String(query || '');
  // Quoted parts are kept whole; only the words between them are looked at.
  const parts = text.split(/("[^"]*")/);
  let removed = false;
  const kept = parts.map(part => {
    if (part.startsWith('"')) return part;
    return part
      .split(/(\s+)/)
      .filter(token => {
        if (!NEWS_WORDS.has(token.toLowerCase())) return true;
        removed = true;
        return false;
      })
      .join('');
  });
  if (!removed) return text;
  const topic = kept.join('').replace(/\s+/g, ' ').trim();
  // Something must be left to be about.
  return meaningfulWords(parseQuery(topic)).length > 0 ? topic : text;
}

module.exports = { newsTopic, NEWS_WORDS };
