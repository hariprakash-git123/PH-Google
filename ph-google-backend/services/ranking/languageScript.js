/**
 * Language compatibility by writing system — shared by the ranker
 * (unifiedRanker), the index query (queryBuilder) and AI retrieval.
 *
 * A query typed in one script is asking for pages in it: an English query
 * for "python" does not want the Japanese article first. Judged on what a
 * text shows plainly (its letters) or on the language the index recorded,
 * never on a guess about which Latin-script language a page is in.
 */

/** The writing systems told apart: what can be seen in a text without guessing its language. */
const SCRIPTS = [
  ['latin', /\p{Script=Latin}/u],
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['telugu', /\p{Script=Telugu}/u],
  ['kannada', /\p{Script=Kannada}/u],
  ['malayalam', /\p{Script=Malayalam}/u],
  ['gujarati', /\p{Script=Gujarati}/u],
  ['gurmukhi', /\p{Script=Gurmukhi}/u]
];

/** The script each language the index records is written in (ISO 639-1). */
const LANGUAGE_SCRIPT = {
  ja: 'cjk',
  zh: 'cjk',
  ko: 'cjk',
  ru: 'cyrillic',
  uk: 'cyrillic',
  bg: 'cyrillic',
  sr: 'cyrillic',
  el: 'greek',
  ar: 'arabic',
  fa: 'arabic',
  ur: 'arabic',
  he: 'hebrew',
  th: 'thai',
  hi: 'devanagari',
  mr: 'devanagari',
  ne: 'devanagari',
  ta: 'tamil',
  bn: 'bengali',
  te: 'telugu',
  kn: 'kannada',
  ml: 'malayalam',
  gu: 'gujarati',
  pa: 'gurmukhi'
};
const LATIN_LANGUAGES = new Set(
  'en fr de es it pt nl sv no nb da fi pl cs sk sl hr ro hu tr id ms vi tl sw et lv lt ga cy eu ca gl af sq is mt'.split(
    ' '
  )
);

/**
 * How many letters of each script a text has.
 * @returns {Map<string, number>}
 */
function scriptCounts(text) {
  const counts = new Map();
  for (const char of String(text || '')) {
    if (!/\p{L}/u.test(char)) continue;
    const found = SCRIPTS.find(([, pattern]) => pattern.test(char));
    const name = found ? found[0] : 'other';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

/** The script most of a text's letters are in, or null for a text with none. */
function dominantScript(text) {
  let best = null;
  let bestCount = 0;
  for (const [name, count] of scriptCounts(text)) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** The script a language code is written in, or null when it is not known. */
function scriptOfLanguage(code) {
  const base = String(code || '')
    .toLowerCase()
    .split(/[-_]/)[0];
  if (LANGUAGE_SCRIPT[base]) return LANGUAGE_SCRIPT[base];
  return LATIN_LANGUAGES.has(base) ? 'latin' : null;
}

/** The share of a text's letters in one other script that makes it that script's page. */
const OTHER_SCRIPT_SHARE = 0.3;

/**
 * Whether a result is in a language the query can be read as asking for.
 *
 * Judged on the writing system, which a text shows plainly: the query's
 * letters against the result's recorded language (the index's) or, where
 * none is recorded (a provider's result), the letters of its title and
 * snippet. Words shared across scripts ("Python" in a Japanese article) do
 * not make a page compatible: a page with a real share of its text in
 * another script (OTHER_SCRIPT_SHARE) is that script's page — a Japanese
 * page naming "Python" four times is still Japanese, though a kanji is one
 * letter where an English word is six; an English page quoting a few
 * foreign words stays English. A query with no letters, or a result with no
 * evidence, is compatible. Latin-script languages are not told apart (an
 * English query may well want a French page).
 *
 * @param {Object} result  { language?, title, snippet }
 * @param {string|null} queryScript  dominantScript of the query's words
 */
function languageCompatible(result, queryScript) {
  if (!queryScript) return true;
  const recorded = scriptOfLanguage(result.language);
  if (recorded) return recorded === queryScript;
  const text = `${result.title || ''} ${String(result.snippet || '').replace(/<[^>]+>/g, ' ')}`;
  const counts = scriptCounts(text);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return true;
  let other = 0;
  for (const [name, count] of counts) {
    if (name !== queryScript && name !== 'other') other = Math.max(other, count);
  }
  return other / total < OTHER_SCRIPT_SHARE;
}

/**
 * The script the results should be in, or null when any will do: a query
 * naming its language (lang:, the language filter) has decided that itself.
 */
function wantedScript(parsed, options = {}) {
  if (options.language) return null;
  if (parsed && Array.isArray(parsed.languages) && parsed.languages.length > 0) return null;
  const words = parsed ? [...(parsed.terms || []), ...(parsed.phrases || [])].join(' ') : '';
  return dominantScript(words || (parsed && parsed.raw) || '');
}

/**
 * Languages the index may record that are written in another script than
 * `script` — what a query in that script should rank lower.
 */
function languagesOutside(script) {
  if (!script) return [];
  return [...Object.keys(LANGUAGE_SCRIPT), ...LATIN_LANGUAGES].filter(
    code => scriptOfLanguage(code) !== script
  );
}

module.exports = {
  scriptCounts,
  dominantScript,
  scriptOfLanguage,
  languageCompatible,
  wantedScript,
  languagesOutside
};
