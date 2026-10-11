// Graded relevance judgments for the live evaluation (0 = not relevant, 1 = relevant,
// 2 = highly relevant, 3 = the ideal answer). Judged on a result's title and URL by
// explicit rules written before the change; a result merely containing a query word
// is NOT relevant unless the rule says so.
const t = r => String(r.title || '').toLowerCase();
const u = r => String(r.url || '').toLowerCase();
const has = (s, ...words) => words.every(w => s.includes(w));
const any = (s, ...words) => words.some(w => s.includes(w));

module.exports = {
  'theory of relativity': r =>
    /wiki\/theory_of_relativity$/.test(u(r))
      ? 3
      : has(t(r), 'relativity')
        ? 2
        : any(t(r), 'spacetime', 'gravitational lens', 'einstein')
          ? 1
          : 0,
  '"climate change"': r =>
    /wiki\/climate_change$/.test(u(r))
      ? 3
      : has(t(r), 'climate change')
        ? 2
        : any(t(r), 'global warming', 'global surface temperature', 'climate system', 'greenhouse')
          ? 1
          : 0,
  'what is a web crawler': r =>
    /wiki\/web_crawler$/.test(u(r))
      ? 3
      : any(t(r), 'web crawler', 'crawler', 'spider', 'robots.txt')
        ? 2
        : any(t(r), 'search engine indexing', 'search engine', 'scrap')
          ? 1
          : 0,
  'how does the immune system work': r =>
    any(t(r), 'immune system')
      ? 3
      : any(t(r), 'immun', 'antibod', 'lymph', 'white blood cell')
        ? 2
        : 0,
  'node.js': r =>
    /^https?:\/\/(www\.)?nodejs\.org\/en\/?(about|learn)?\/?$/.test(u(r)) ||
    /wiki\/node\.js$/.test(u(r))
      ? 3
      : u(r).includes('nodejs.org')
        ? 1
        : has(t(r), 'node') && any(t(r), 'node.js', 'nodejs')
          ? 1
          : 0,
  mongodb: r =>
    /wiki\/mongodb$/.test(u(r)) || /^https?:\/\/(www\.)?mongodb\.com\/?$/.test(u(r))
      ? 3
      : any(t(r), 'mongodb') || u(r).includes('mongodb.com')
        ? 2
        : any(t(r), 'nosql', 'document-oriented')
          ? 1
          : 0,
  youtube: r =>
    /^https?:\/\/(www\.)?youtube\.com\/?$/.test(u(r).replace(/;$/, ''))
      ? 3
      : u(r).includes('youtube.com') || /wiki\/youtube$/.test(u(r))
        ? 1
        : 0,
  'relativty theory': r =>
    /wiki\/theory_of_relativity$/.test(u(r)) ? 3 : has(t(r), 'relativity') ? 2 : 0,
  'heart attack symptoms': r =>
    has(t(r), 'heart attack') && any(t(r), 'symptom', 'sign', 'warning')
      ? 3
      : has(t(r), 'heart attack')
        ? 2
        : any(t(r), 'heart disease', 'cardiac', 'chest pain')
          ? 1
          : 0,
  'intitle:geometry': r => (has(t(r), 'geometry') ? (/wiki\/geometry$/.test(u(r)) ? 3 : 2) : 0),
  'climate change -wikipedia': r =>
    u(r).includes('wikipedia.org')
      ? 0
      : has(t(r), 'climate') && any(t(r), 'change', 'warming')
        ? 3
        : any(t(r), 'climate', 'greenhouse', 'global warming')
          ? 2
          : 0,
  'kuiper belt vs oort cloud': r =>
    has(t(r), 'kuiper') && has(t(r), 'oort')
      ? 3
      : any(t(r), 'kuiper belt', 'oort cloud')
        ? 2
        : any(t(r), 'comet', 'trans-neptunian', 'dwarf planet')
          ? 1
          : 0,
  'techcrunch disrupt 2026': r =>
    has(t(r), 'disrupt') && u(r).includes('techcrunch.com')
      ? 3
      : has(t(r), 'disrupt')
        ? 2
        : u(r).includes('techcrunch.com')
          ? 1
          : 0,
  'latest github copilot news': r =>
    has(t(r), 'copilot') && any(t(r), 'github')
      ? 3
      : has(t(r), 'copilot')
        ? 2
        : u(r).includes('github.blog')
          ? 1
          : 0,
  'air pollution health effects': r =>
    any(t(r), 'air pollution', 'air quality')
      ? 3
      : any(t(r), 'particulate', 'air pollutant', 'pollution')
        ? 2
        : any(t(r), 'air topics', 'ozone', 'smog')
          ? 1
          : 0,
  football: r =>
    /wiki\/association_football$/.test(u(r)) || /wiki\/(american_)?football$/.test(u(r))
      ? 3
      : any(t(r), 'football')
        ? 2
        : 0
};
