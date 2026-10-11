const { newsTopic } = require('../../services/ranking/newsIntent');

/**
 * What a News search is about: the query without the words that only ask
 * for news ("news", "latest", "breaking", "headline(s)"). No topic or site is
 * named in the rule; it applies to any subject.
 */

describe('newsTopic', () => {
  it.each([
    ['python release news', 'python release'],
    ['latest iphone', 'iphone'],
    ['mars rover news', 'mars rover'],
    ['Breaking News on the kerala monsoon', 'on the kerala monsoon'],
    ['election headlines today', 'election today'],
    ['NEWS chicken biryani', 'chicken biryani']
  ])('%s -> %s', (query, topic) => {
    expect(newsTopic(query)).toBe(topic);
  });

  it.each([
    // Nothing else to be about: kept, so the tab still lists the news.
    'news',
    'latest news',
    'breaking news',
    // Typed precisely: inside quotes, negated, or with only an operator left.
    '"breaking news" ukraine',
    '-news python',
    'site:bbc.co.uk news',
    // No news words at all.
    'python release'
  ])('%s is kept as typed', query => {
    expect(newsTopic(query)).toBe(query);
  });

  it('never returns an empty query', () => {
    expect(newsTopic('')).toBe('');
    expect(newsTopic('   news   ')).toBe('   news   ');
  });
});
