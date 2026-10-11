const navigational = require('../../services/ranking/navigational');
const OFFICIAL_SITES = require('../../config/officialSites');

/**
 * Navigational searches: only a search that is clearly the name of a site
 * qualifies; a page is official by its address, never its title; official
 * pages already found move to the top, and nothing is ever added.
 */

const { detect, isOfficial, promoteOfficial } = navigational;
const r = (url, title = '') => ({ url, title, source: 'parallel' });

describe('detect', () => {
  it.each([
    ['youtube', 'youtube'],
    ['YouTube', 'youtube'],
    ['  youtube  ', 'youtube'],
    ['you tube', 'youtube'],
    ['youtube official website', 'youtube'],
    ['youtube.com', 'youtube'],
    ['www.youtube.com', 'youtube'],
    ['gmail', 'gmail'],
    ['gmail login', 'gmail'],
    ['gmail sign in', 'gmail'],
    ['google maps', 'google maps'],
    ['stack overflow', 'stack overflow'],
    ['github.com', 'github']
  ])('%j is a search for the site %s', (query, name) => {
    expect(detect(query)).toMatchObject({ name });
  });

  it('a domain nobody listed, typed on its own, is a search for that domain', () => {
    expect(detect('example.org')).toEqual({
      name: 'example.org',
      sites: [{ host: 'example.org' }]
    });
  });

  it.each([
    'youtube app download',
    'youtube premium pricing',
    'youtube tutorial',
    'how to upload to youtube',
    'best youtube videos',
    'youtube vs tiktok',
    'gmail storage full',
    'google maps api',
    'maps',
    'mail',
    'restaurants in coimbatore',
    'mathematics',
    '',
    '   ',
    null,
    'youtube '.repeat(20)
  ])('%j asks for something else, or nothing: not navigational', query => {
    expect(detect(query)).toBeNull();
  });

  it('every listed site is well formed', () => {
    for (const entry of OFFICIAL_SITES) {
      expect(entry.names.length).toBeGreaterThan(0);
      entry.names.forEach(name => expect(name).toBe(name.toLowerCase().trim()));
      entry.sites.forEach(site => {
        expect(site.host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(site.host.startsWith('www.')).toBe(false);
        if (site.path) expect(site.path).toMatch(/^\/[a-z0-9/-]+$/);
      });
    }
    // One name means one site.
    const names = OFFICIAL_SITES.flatMap(entry => entry.names);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('isOfficial (by address, never by title)', () => {
  const youtube = detect('youtube').sites;
  const maps = detect('google maps').sites;
  const gmail = detect('gmail').sites;

  it.each([
    ['https://www.youtube.com/', youtube, true],
    ['https://youtube.com/watch?v=x', youtube, true],
    ['https://m.youtube.com/', youtube, true],
    ['https://youtu.be/abc', youtube, true],
    ['https://play.google.com/store/apps/details?id=com.google.android.youtube', youtube, false],
    ['https://en.wikipedia.org/wiki/YouTube', youtube, false],
    ['https://youtube.com.evil.example/', youtube, false],
    ['https://notyoutube.com/', youtube, false],
    ['https://www.google.com/maps', maps, true],
    ['https://www.google.co.uk/maps/place/x', maps, true],
    ['https://maps.google.com/', maps, true],
    ['https://developers.google.com/maps/documentation', maps, false],
    ['https://www.google.com/mapsearch', maps, false],
    ['https://www.google.com/search?q=maps', maps, false],
    ['https://mail.google.com/mail/u/0/', gmail, true],
    ['https://www.google.com/gmail/about/', gmail, true],
    ['https://developers.google.com/workspace/gmail/api', gmail, false],
    ['javascript:alert(1)', youtube, false],
    ['not a url', youtube, false]
  ])('%s → %s', (url, sites, expected) => {
    expect(isOfficial(url, sites)).toBe(expected);
  });
});

describe('promoteOfficial', () => {
  const intent = detect('youtube');

  it('moves the official pages to the top, home page first, everything else in order', () => {
    const results = [
      r(
        'https://play.google.com/store/apps/details?id=com.google.android.youtube',
        'YouTube - Apps on Google Play'
      ),
      r('https://sv.wikipedia.org/wiki/Youtube', 'Youtube – Wikipedia'),
      r('https://www.youtube.com/YouTube/en', 'YouTube - YouTube'),
      r('https://sea.mashable.com/youtube', 'YouTube'),
      r('https://www.youtube.com/', 'YouTube')
    ];
    const out = promoteOfficial(results, intent);
    expect(out.promoted).toBe(2);
    expect(out.results.map(x => x.url)).toEqual([
      'https://www.youtube.com/',
      'https://www.youtube.com/YouTube/en',
      'https://play.google.com/store/apps/details?id=com.google.android.youtube',
      'https://sv.wikipedia.org/wiki/Youtube',
      'https://sea.mashable.com/youtube'
    ]);
    // Same results, same objects: nothing added, removed or altered.
    expect(out.results).toHaveLength(results.length);
    expect(new Set(out.results)).toEqual(new Set(results));
  });

  it('with no official page among the results, nothing changes and nothing is added', () => {
    const results = [
      r('https://play.google.com/store/apps/details?id=x'),
      r('https://sea.mashable.com/youtube')
    ];
    const out = promoteOfficial(results, intent);
    expect(out).toEqual({ results, promoted: 0 });
  });

  it('a title that names the site does not make a page official', () => {
    const results = [
      r('https://fan.example/', 'YouTube — the official YouTube site'),
      r('https://www.youtube.com/', 'Home')
    ];
    expect(promoteOfficial(results, intent).results.map(x => x.url)).toEqual([
      'https://www.youtube.com/',
      'https://fan.example/'
    ]);
  });

  it('a search that is not navigational is never reordered', () => {
    const results = [r('https://play.google.com/x'), r('https://www.youtube.com/')];
    expect(promoteOfficial(results, null)).toEqual({ results, promoted: 0 });
    expect(promoteOfficial(results, detect('youtube app download'))).toEqual({
      results,
      promoted: 0
    });
  });

  it('survives junk', () => {
    expect(promoteOfficial(null, intent)).toEqual({ results: [], promoted: 0 });
    expect(promoteOfficial([null, r('https://www.youtube.com/')], intent).results[0].url).toBe(
      'https://www.youtube.com/'
    );
  });
});
