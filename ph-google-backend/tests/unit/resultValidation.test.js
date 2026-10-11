const { config } = require('../../config/env');
const logger = require('../../utils/logger');
const { parseQuery } = require('../../services/opensearch/queryParser');
const {
  assessCoverage,
  coversQuery,
  meaningfulTerms
} = require('../../services/external/resultRelevance');
const externalSearch = require('../../services/externalSearch');
const serpApiClient = require('../../services/external/serpApiClient');
const bingSearchClient = require('../../services/external/bingSearchClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');

/**
 * Three things that keep one bad or slow provider answer from spoiling the
 * rest:
 *
 *   1. an answer that does not cover the query is rejected — not shown, not
 *      cached — and SerpApi is asked once more for a fresh one;
 *   2. repeated failures pause the operation that failed (web, images,
 *      videos, …), not the whole provider — unless the account is the
 *      problem (rejected key, rate limit);
 *   3. a failure is logged with what failed, and never with a key.
 *
 * No real provider is called.
 */

const SERP_KEY = 'validation-test-serpapi-key-NOT-REAL';
const BING_KEY = 'validation-test-bing-key-NOT-REAL';

const page = (title, url, snippet = '') => ({ title, url, snippet });

// What SerpApi returned on 2026-10-07 for "tirunelveli halwa recipe": pages
// about the word "recipe".
const RECIPE_ONLY = [
  page(
    'Recipe Schema Markup | Google Search Central',
    'https://developers.google.com/search/docs/recipe'
  ),
  page("Whenever I don't know what to make for dinner ...", 'https://www.youtube.com/watch?v=a1'),
  page('Recipe', 'https://en.wikipedia.org/wiki/Recipe'),
  page('Recipe - Schema.org Type', 'https://schema.org/Recipe'),
  page('Poha Recipe with a Twist | Healthy Vegetable Poha', 'https://www.youtube.com/watch?v=a2'),
  page('RECIPE | English meaning - Cambridge Dictionary', 'https://dictionary.cambridge.org/recipe')
];
// And a fresh copy of the same search.
const HALWA = [
  page(
    'How to make godhumai halwa - Tirunelveli',
    'https://example.org/godhumai',
    'A wheat halwa recipe.'
  ),
  page('Tirunelveli Halwa ~ Halwa with Cracked Wheat', 'https://food.example/tirunelveli-halwa'),
  page('Tirunelveli Halwa Recipe in Tamil', 'https://www.youtube.com/watch?v=b1'),
  page('Homemade sweets', 'https://sweets.example/', 'Laddu, mysore pak and more.')
];
// What the RapidAPI Bing endpoint returned for "best pizza in chennai".
const BEST_ONLY = [
  page('Best Buy | Official Online Store | Shop Now & Save', 'https://www.bestbuy.com/'),
  page(
    'BEST Definition & Meaning - Merriam-Webster',
    'https://www.merriam-webster.com/dictionary/best'
  ),
  page('Best - definition of best by The Free Dictionary', 'https://www.thefreedictionary.com/best')
];

const asSerp = list =>
  list.map((r, i) => ({ position: i + 1, title: r.title, link: r.url, snippet: r.snippet }));
const asBing = list => list.map(r => ({ title: r.title, link: r.url, description: r.snippet }));

describe('which words of a query carry its meaning', () => {
  it.each([
    ['best pizza in chennai', ['pizza', 'chennai']],
    ['tirunelveli halwa recipe', ['tirunelveli', 'halwa', 'recipe']],
    ['how to learn Python', ['learn', 'python']],
    ['best restaurants in Chennai', ['restaurant', 'chennai']],
    ['the top 10 movies for kids', ['10', 'movie', 'kid']],
    ['"climate change" effects', ['effect', 'climate', 'change']],
    ['what is the best', []]
  ])('%s → %j', (query, expected) => {
    expect(meaningfulTerms(parseQuery(query))).toEqual(expected);
  });
});

describe('whether an answer covers the query', () => {
  const halwa = parseQuery('tirunelveli halwa recipe');
  const pizza = parseQuery('best pizza in chennai');

  it('rejects pages that share only one ordinary word with the query', () => {
    expect(assessCoverage(RECIPE_ONLY, halwa)).toMatchObject({ relevant: false, covering: 0 });
    expect(coversQuery(BEST_ONLY, pizza)).toBe(false);
  });

  it('accepts an answer where enough results are about the query', () => {
    // Three of four cover it; the odd one out does not sink the answer.
    expect(assessCoverage(HALWA, halwa)).toMatchObject({ relevant: true, covering: 3, needed: 2 });
  });

  it('finds the words in the title, the snippet or the address, in any form', () => {
    const results = [
      page('Where to eat', 'https://food.example/chennai/pizzas', ''),
      page('PIZZERIAS', 'https://x.example/', 'The best pizza places of Chennai.')
    ];
    expect(assessCoverage(results, pizza)).toMatchObject({ relevant: true, covering: 2 });
  });

  it('a word that only fits any subject does not count as coverage', () => {
    expect(coversQuery([page('The best of the best', 'https://x.example/best')], pizza)).toBe(
      false
    );
  });

  it('does not judge what it cannot: no meaningful words, or no results', () => {
    expect(coversQuery(BEST_ONLY, parseQuery('what is the best'))).toBe(true);
    expect(coversQuery(BEST_ONLY, parseQuery('site:bestbuy.com'))).toBe(true);
    expect(coversQuery([], halwa)).toBe(true);
  });

  it('works for a query that is not in Latin script', () => {
    const tamil = parseQuery('அல்வா செய்முறை');
    expect(coversQuery([page('திருநெல்வேலி அல்வா செய்முறை', 'https://x.example/1')], tamil)).toBe(
      true
    );
    expect(coversQuery(RECIPE_ONLY, tamil)).toBe(false);
  });
});

describe('external search', () => {
  const original = {
    serpapi: { ...config.serpapi },
    bing: { ...config.bing },
    externalSearch: { ...config.externalSearch }
  };
  const internal = () => ({
    query: 'q',
    results: [
      {
        id: 'i1',
        url: 'https://en.wikipedia.org/wiki/India',
        title: 'India',
        snippet: '',
        score: 3
      }
    ],
    totalResults: 3,
    reachableResults: 3,
    duplicatesRemoved: 0,
    responseTimeMs: 4,
    engine: 'opensearch',
    quality: { fullMatches: 0, aboutMatches: 0 }
  });
  const run = (query = 'tirunelveli halwa recipe') =>
    externalSearch.searchWithExternal({ query, page: 1, limit: 10 }, async () => internal());
  const titles = out => out.results.map(r => `${r.source}: ${r.title}`);

  let serp;
  let bing;
  let warn;

  beforeEach(() => {
    externalSearch.reset();
    Object.assign(config.externalSearch, {
      provider: 'serpapi',
      fallback: true,
      relevanceGate: true,
      validateResults: true
    });
    Object.assign(config.serpapi, original.serpapi, {
      enabled: true,
      apiKey: SERP_KEY,
      engine: 'google',
      minInternalResults: 3,
      dailyLimit: 0,
      cacheTtlMs: 60000
    });
    Object.assign(config.bing, original.bing, {
      apiKey: BING_KEY,
      dailyLimit: 0,
      cacheTtlMs: 60000
    });
    serp = jest.spyOn(serpApiClient, 'searchGoogle').mockResolvedValue({ results: asSerp(HALWA) });
    bing = jest.spyOn(bingSearchClient, 'searchWeb').mockResolvedValue({ results: asBing(HALWA) });
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    Object.assign(config.serpapi, original.serpapi);
    Object.assign(config.bing, original.bing);
    Object.assign(config.externalSearch, original.externalSearch);
  });

  describe('1. an answer that does not cover the query', () => {
    it('a good answer is used as before: one request, same result format', async () => {
      const out = await run();
      expect(serp).toHaveBeenCalledTimes(1);
      expect(serp.mock.calls[0][0].params || {}).not.toHaveProperty('no_cache');
      expect(out.external).toEqual({
        provider: 'serpapi',
        status: 'ok',
        // Three of the four are about the halwa; "Homemade sweets" is not, and is left out.
        count: 3,
        cached: false,
        indexQuality: 'weak',
        indexCovering: 0,
        placement: 'ranked'
      });
      // Ranked with the index's results: the one whose title has every word
      // of the query ("tirunelveli halwa recipe") leads.
      expect(titles(out)[0]).toBe('serpapi: Tirunelveli Halwa Recipe in Tamil');
      expect(titles(out)).toContain('serpapi: How to make godhumai halwa - Tirunelveli');
      // Accepting the answer does not mean showing all of it.
      expect(titles(out).join('|')).not.toContain('Homemade sweets');
      expect(warn).not.toHaveBeenCalled();
    });

    it('is rejected, and SerpApi is asked once more for a fresh copy', async () => {
      serp
        .mockResolvedValueOnce({ results: asSerp(RECIPE_ONLY) })
        .mockResolvedValueOnce({ results: asSerp(HALWA) });
      const out = await run();

      expect(serp).toHaveBeenCalledTimes(2);
      expect(serp.mock.calls[1][0]).toMatchObject({
        q: 'tirunelveli halwa recipe',
        params: { no_cache: 'true' }
      });
      expect(bing).not.toHaveBeenCalled();
      // The fresh answer is shown, in the usual format; none of the bad one is.
      expect(out.external).toEqual({
        provider: 'serpapi',
        status: 'ok',
        // Three of the four are about the halwa; "Homemade sweets" is not, and is left out.
        count: 3,
        cached: false,
        indexQuality: 'weak',
        indexCovering: 0,
        placement: 'ranked'
      });
      expect(titles(out).join('|')).not.toContain('Schema');
      expect(Object.keys(out.results[0]).sort()).toEqual(
        Object.keys((await run('another halwa recipe tirunelveli')).results[0]).sort()
      );
    });

    it('the rejected answer is not cached; the accepted one is', async () => {
      serp
        .mockResolvedValueOnce({ results: asSerp(RECIPE_ONLY) })
        .mockResolvedValueOnce({ results: asSerp(HALWA) });
      await run();
      const again = await run();
      expect(serp).toHaveBeenCalledTimes(2); // no third request
      expect(again.external).toMatchObject({ status: 'ok', cached: true });
      expect(titles(again).join('|')).not.toContain('Schema');
    });

    it('when the fresh copy is no better, the other provider is asked', async () => {
      serp.mockResolvedValue({ results: asSerp(RECIPE_ONLY) });
      const out = await run();
      expect(serp).toHaveBeenCalledTimes(2); // once, and once fresh — no more
      expect(bing).toHaveBeenCalledTimes(1);
      expect(out.external).toEqual({
        provider: 'bing',
        status: 'ok',
        // Three of the four are about the halwa; "Homemade sweets" is not, and is left out.
        count: 3,
        cached: false,
        fallbackFrom: 'serpapi',
        fallbackReason: 'irrelevant_results',
        indexQuality: 'weak',
        indexCovering: 0,
        placement: 'ranked'
      });
    });

    it('when no provider has a usable answer, the index results stand alone and nothing is cached', async () => {
      serp.mockResolvedValue({ results: asSerp(RECIPE_ONLY) });
      bing.mockResolvedValue({ results: asBing(BEST_ONLY) });
      const out = await run();
      expect(titles(out)).toEqual(['index: India']);
      expect(out.external).toEqual({
        provider: 'serpapi',
        status: 'unavailable',
        count: 0,
        reason: 'irrelevant_results',
        indexQuality: 'weak',
        indexCovering: 0
      });

      // Nothing was kept: the next search asks again, and can succeed.
      serp.mockResolvedValue({ results: asSerp(HALWA) });
      const next = await run();
      expect(next.external).toMatchObject({ provider: 'serpapi', status: 'ok', cached: false });
    });

    it('Bing as the first provider is checked too (no fresh retry: it has no stored copy)', async () => {
      config.externalSearch.provider = 'bing';
      bing.mockResolvedValue({ results: asBing(BEST_ONLY) });
      serp.mockResolvedValue({
        results: asSerp([page('Best pizza in Chennai', 'https://food.example/pizza-chennai')])
      });
      const out = await run('best pizza in chennai');
      expect(bing).toHaveBeenCalledTimes(1);
      expect(out.external).toMatchObject({
        provider: 'serpapi',
        status: 'ok',
        fallbackFrom: 'bing',
        fallbackReason: 'irrelevant_results'
      });
      expect(titles(out)[0]).toBe('serpapi: Best pizza in Chennai');
    });

    it('a rejected answer is not an outage: it never pauses the provider', async () => {
      config.externalSearch.fallback = false;
      serp.mockResolvedValue({ results: asSerp(RECIPE_ONLY) });
      for (const q of ['halwa one', 'halwa two', 'halwa three', 'halwa four']) await run(q);
      expect(serp).toHaveBeenCalledTimes(8); // every search still asked, twice each
    });

    it('logs the rejection, without the key', async () => {
      serp
        .mockResolvedValueOnce({ results: asSerp(RECIPE_ONLY) })
        .mockResolvedValueOnce({ results: asSerp(HALWA) });
      await run();
      expect(warn).toHaveBeenCalledWith('External results rejected: they do not cover the query', {
        provider: 'serpapi',
        operation: 'web',
        query: 'tirunelveli halwa recipe',
        reason: 'irrelevant_results',
        resultCount: 6,
        durationMs: expect.any(Number)
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SERP_KEY);
    });

    it('EXTERNAL_RESULT_VALIDATION=false accepts whatever arrives', async () => {
      config.externalSearch.validateResults = false;
      serp.mockResolvedValue({ results: asSerp(RECIPE_ONLY) });
      const out = await run();
      expect(serp).toHaveBeenCalledTimes(1);
      expect(out.external).toMatchObject({ status: 'ok', count: 6 });
    });
  });

  describe('2. a pause covers the operation that failed', () => {
    const timeout = () => new ExternalSearchError('timeout', 'slow');
    const ok = { results: [{ title: 'x' }] };
    /** One request for an operation; `send` is what the provider does. */
    const ask = (operation, q, send) =>
      externalSearch.fetchCached(operation, { engine: `google_${operation}`, q }, send);
    const failing = jest.fn(async () => {
      throw timeout();
    });
    /** Three failures in a row: enough to pause. */
    const breakDown = async operation => {
      for (const q of ['a', 'b', 'c']) await ask(operation, q, failing);
      const blocked = jest.fn(async () => ok);
      expect(await ask(operation, 'd', blocked)).toEqual({
        status: 'unavailable',
        reason: 'timeout'
      });
      expect(blocked).not.toHaveBeenCalled(); // paused: not even sent
    };
    let asked = 0;
    /** A new request for the operation is sent and answered. */
    const works = async operation => {
      const send = jest.fn(async () => ok);
      asked += 1;
      const outcome = await ask(operation, `still works ${asked}`, send);
      return outcome.status === 'ok' && send.mock.calls.length === 1;
    };

    it('web timeouts do not disable Images (or Videos, Maps, Trending)', async () => {
      serp.mockRejectedValue(timeout());
      config.externalSearch.fallback = false;
      for (const q of ['w1 halwa', 'w2 halwa', 'w3 halwa', 'w4 halwa']) await run(q);
      expect(serp).toHaveBeenCalledTimes(3); // the fourth web search was not sent

      for (const operation of ['images', 'videos', 'maps', 'trending'])
        expect(await works(operation)).toBe(true);
    });

    it('Images timeouts do not disable Videos', async () => {
      await breakDown('images');
      expect(await works('videos')).toBe(true);
    });

    it('Videos timeouts do not disable web search', async () => {
      await breakDown('videos');
      const out = await run();
      expect(serp).toHaveBeenCalledTimes(1);
      expect(out.external).toMatchObject({ provider: 'serpapi', status: 'ok' });
      expect(await works('images')).toBe(true);
    });

    it('a success in between starts the count again', async () => {
      await ask('videos', 'a', failing);
      await ask('videos', 'b', failing);
      expect(await works('videos')).toBe(true);
      await ask('videos', 'c', failing);
      await ask('videos', 'd', failing);
      expect(await works('videos')).toBe(true);
    });

    it.each([
      ['a rejected key', new ExternalSearchError('auth', 'rejected', { status: 401 }), 'auth'],
      [
        'a rate limit',
        new ExternalSearchError('rate_limited', 'slow down', { status: 429 }),
        'rate_limited'
      ]
    ])('%s still pauses the whole provider, at once', async (_label, error, reason) => {
      await ask('videos', 'a', async () => {
        throw error;
      });
      for (const operation of ['web', 'images', 'videos', 'maps']) {
        const send = jest.fn(async () => ok);
        expect(await ask(operation, 'next', send)).toEqual({ status: 'unavailable', reason });
        expect(send).not.toHaveBeenCalled();
      }
    });

    it('one provider pausing does not pause the other', async () => {
      await breakDown('web');
      const send = jest.fn(async () => ok);
      const out = await externalSearch.fetchCached('web', { keyword: 'x' }, send, 'bing');
      expect(out.status).toBe('ok');
    });
  });

  describe('3. what a failure logs', () => {
    it('provider, operation, query, reason, HTTP status and duration — never the key', async () => {
      await externalSearch.fetchCached(
        'videos',
        { engine: 'google_videos', q: 'latest AI news', params: { api_key: SERP_KEY } },
        async () => {
          throw new ExternalSearchError('unavailable', `SerpApi answered 503 for ${SERP_KEY}.`, {
            status: 503
          });
        }
      );
      expect(warn).toHaveBeenCalledWith('SerpApi request failed; showing index results only', {
        provider: 'serpapi',
        operation: 'videos',
        query: 'latest AI news',
        reason: 'unavailable',
        status: 503,
        durationMs: expect.any(Number),
        pausedForMs: undefined,
        pauseScope: undefined
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SERP_KEY);
    });

    it('says when a pause begins, what it covers, and when a request was not sent because of it', async () => {
      const failing = async () => {
        throw new ExternalSearchError('timeout', 'slow');
      };
      for (const q of ['a', 'b', 'c']) {
        await externalSearch.fetchCached('videos', { engine: 'google_videos', q }, failing);
      }
      expect(warn.mock.calls[2][1]).toMatchObject({
        operation: 'videos',
        reason: 'timeout',
        pausedForMs: 60000,
        pauseScope: 'operation'
      });

      await externalSearch.fetchCached('videos', { engine: 'google_videos', q: 'd' }, failing);
      expect(warn).toHaveBeenLastCalledWith(
        'External request not sent: paused after earlier failures',
        {
          provider: 'serpapi',
          operation: 'videos',
          query: 'd',
          reason: 'timeout',
          pauseScope: 'operation',
          resumesInMs: expect.any(Number)
        }
      );
    });
  });
});

describe('timeout settings', () => {
  const load = env => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let loaded;
    jest.isolateModules(() => {
      loaded = require('../../config/env').config;
    });
    for (const name of Object.keys(env)) delete process.env[name];
    Object.assign(process.env, saved);
    return loaded;
  };

  it('defaults are unchanged: web 3 s, tabs 8 s, trending 8 s', () => {
    const c = load({});
    expect([c.serpapi.timeoutMs, c.serpapi.verticalTimeoutMs, c.trending.timeoutMs]).toEqual([
      3000, 8000, 8000
    ]);
  });

  it('SERPAPI_WEB_TIMEOUT_MS sets the web timeout, and wins over the older name', () => {
    expect(load({ SERPAPI_WEB_TIMEOUT_MS: '12000' }).serpapi.timeoutMs).toBe(12000);
    expect(load({ SERPAPI_TIMEOUT_MS: '5000' }).serpapi.timeoutMs).toBe(5000);
    expect(
      load({ SERPAPI_WEB_TIMEOUT_MS: '12000', SERPAPI_TIMEOUT_MS: '5000' }).serpapi.timeoutMs
    ).toBe(12000);
  });

  it('the tabs timeout does not move the web or trending timeouts', () => {
    const c = load({ SERPAPI_VERTICAL_TIMEOUT_MS: '20000' });
    expect(c.serpapi.verticalTimeoutMs).toBe(20000);
    expect(c.serpapi.timeoutMs).toBe(3000);
    expect(c.trending.timeoutMs).toBe(8000);
  });
});
