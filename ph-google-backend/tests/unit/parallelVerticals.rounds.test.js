const parallelVerticals = require('../../services/parallelVerticals');
const { parseQuery } = require('../../services/opensearch/queryParser');

/**
 * Parallel has no paging, so "Load more" on Images and Videos asks again in
 * other words: a round of requests at a time. Each round asks only what no
 * earlier round asked, and there is a last round.
 */

const round = (category, query, n) =>
  parallelVerticals.buildRequest(parseQuery(query), category, { sort: 'relevance' }, n);

describe('rounds of requests for Load more', () => {
  it('Images: six rounds, each worded differently', () => {
    expect(parallelVerticals.maxRounds('images')).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map(n => round('images', 'red panda', n).searchQueries)).toEqual([
      ['red panda photos', 'red panda images'],
      ['red panda pictures', 'red panda photography'],
      ['red panda photo gallery', 'free red panda photos'],
      ['red panda hd pictures', 'red panda stock photos'],
      ['red panda pics', 'red panda image collection'],
      ['best red panda photos', 'red panda high resolution images']
    ]);
  });

  it('Videos: three rounds, each worded differently', () => {
    expect(parallelVerticals.maxRounds('videos')).toBe(3);
    expect([0, 1, 2].map(n => round('videos', 'red panda', n).searchQueries)).toEqual([
      ['red panda video', 'red panda', 'best red panda'],
      ['red panda videos', 'red panda youtube', 'watch red panda'],
      ['red panda clip', 'red panda full video', 'new red panda videos']
    ]);
  });

  it('no round repeats words an earlier round used', () => {
    // "videos" in the query: round one's "<q> video(s)" words are already asked.
    const all = [0, 1, 2].flatMap(n => round('videos', 'cat videos', n).searchQueries || []);
    expect(new Set(all.map(q => q.toLowerCase())).size).toBe(all.length);
  });

  it('there is no round after the last, and Maps has one round only', () => {
    expect(round('images', 'red panda', 6)).toEqual({ skip: true, reason: 'no_more_rounds' });
    expect(round('videos', 'red panda', 3)).toEqual({ skip: true, reason: 'no_more_rounds' });
    expect(parallelVerticals.maxRounds('maps')).toBe(1);
  });

  it('every round keeps the filters of the first', () => {
    const params = { sort: 'relevance', domain: 'youtube.com' };
    const first = parallelVerticals.buildRequest(parseQuery('red panda'), 'videos', params, 0);
    const later = parallelVerticals.buildRequest(parseQuery('red panda'), 'videos', params, 2);
    expect(later.sourcePolicy).toEqual(first.sourcePolicy);
    expect(later.objective).toBe(first.objective);
  });
});
