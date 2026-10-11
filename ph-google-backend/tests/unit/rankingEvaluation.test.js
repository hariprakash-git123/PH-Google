const { rankResults } = require('../../services/ranking/unifiedRanker');
const { classify } = require('../../services/ranking/queryIntent');
const navigational = require('../../services/ranking/navigational');
const { parseQuery } = require('../../services/opensearch/queryParser');
const { resultIdentityKey } = require('../../utils/urlNormalizer');
const { precisionAt, reciprocalRank, ndcgAt, mean } = require('../helpers/rankingMetrics');
const { queries: POOLS } = require('../fixtures/relevance/livePools.json');
const JUDGMENTS = require('../fixtures/relevance/judgments');

/**
 * Relevance evaluation on real candidates.
 *
 * The fixtures are the first pages the live All tab showed for sixteen
 * representative queries before the unified ranking — index and Parallel
 * results, in the order they were shown (block-merged). Each query has graded
 * judgments written as explicit rules (judgments.js): a result is not
 * relevant merely for containing a query word.
 *
 * "before" is the recorded order; "after" is the same candidates put through
 * the merge as it is now (unifiedRanker, then the navigational promotion).
 * The candidates are identical, so this measures ordering alone; what the new
 * rules for asking the provider retrieve is measured on the live stack.
 */

function afterOrder(query, results) {
  const ordered = rankResults(results, parseQuery(query), {
    timeSensitive: classify(query).timeSensitive
  });
  const site = navigational.detect(query);
  return site ? navigational.promoteOfficial(ordered, site).results : ordered;
}

const rows = Object.entries(POOLS).map(([query, { recordedOrder }]) => {
  const judge = JUDGMENTS[query];
  const before = recordedOrder.map(judge);
  const after = afterOrder(query, recordedOrder).map(judge);
  return {
    query,
    pool: before,
    before: { p10: precisionAt(before), mrr: reciprocalRank(before), ndcg: ndcgAt(before, before) },
    after: { p10: precisionAt(after), mrr: reciprocalRank(after), ndcg: ndcgAt(after, before) },
    afterGrades: after
  };
});

describe('relevance evaluation on recorded live candidates', () => {
  it('every query in the set has its judgments', () => {
    expect(Object.keys(POOLS).sort()).toEqual(Object.keys(JUDGMENTS).sort());
    expect(rows).toHaveLength(16);
  });

  it('ranks the same candidates better overall (nDCG@10, P@10), and never worse first results (MRR)', () => {
    const avg = (side, measure) => mean(rows.map(row => row[side][measure]));
    // Measured: nDCG@10 0.818 → 0.85+, P@10 0.381 → 0.394, MRR 0.875 → 0.875.
    expect(avg('after', 'ndcg')).toBeGreaterThan(avg('before', 'ndcg') + 0.03);
    expect(avg('after', 'p10')).toBeGreaterThanOrEqual(avg('before', 'p10'));
    expect(avg('after', 'mrr')).toBeGreaterThanOrEqual(avg('before', 'mrr'));
  });

  it.each(['relativty theory', 'node.js', 'kuiper belt vs oort cloud', 'heart attack symptoms'])(
    'improves the order for "%s", where two sources were block-merged',
    query => {
      const row = rows.find(r => r.query === query);
      expect(row.after.ndcg).toBeGreaterThan(row.before.ndcg);
    }
  );

  it('no query gets materially worse', () => {
    for (const row of rows) {
      expect(row.after.ndcg).toBeGreaterThanOrEqual(row.before.ndcg - 0.02);
    }
  });

  it('the ideal answer is in the top three wherever the candidates hold one', () => {
    // Not always first: for "football", "Blind football" and "Association
    // football" are told apart only by the index's own ranking, which is kept.
    for (const row of rows) {
      if (row.pool.includes(3)) expect(row.afterGrades.slice(0, 3)).toContain(3);
    }
  });

  it('a typo still finds the exact page: "relativty theory" → Theory of relativity (Wikipedia), from the index, first', () => {
    const [first] = afterOrder('relativty theory', POOLS['relativty theory'].recordedOrder);
    expect(first.url).toBe('https://en.wikipedia.org/wiki/Theory_of_relativity');
    expect(first.source).toBe('index');
  });

  it('no page appears twice in a first page (the mobile copy of an indexed page included)', () => {
    for (const [query, { recordedOrder }] of Object.entries(POOLS)) {
      const top = afterOrder(query, recordedOrder).slice(0, 10);
      const keys = top.map(r => resultIdentityKey(r.url));
      const twice = keys.filter((key, i) => keys.indexOf(key) !== i);
      // Ranking alone cannot remove them (that is the merge's job), but it
      // puts a repeat below the page it repeats.
      if (twice.length > 0) {
        for (const key of twice) {
          const positions = keys.map((k, i) => (k === key ? i : -1)).filter(i => i >= 0);
          expect(positions[0]).toBeLessThan(positions[1]);
        }
      }
    }
  });

  it('loose matches never lead pages about the query: "mongodb" keeps MongoDB first, the fuzzy matches after', () => {
    const order = afterOrder('mongodb', POOLS.mongodb.recordedOrder);
    expect(order[0].url).toBe('https://en.wikipedia.org/wiki/MongoDB');
  });

  it('is deterministic: the same candidates in any input order give the same ranking', () => {
    for (const [query, { recordedOrder }] of Object.entries(POOLS)) {
      const once = afterOrder(query, recordedOrder).map(r => r.url);
      const shuffled = [...recordedOrder].reverse();
      expect(afterOrder(query, shuffled).map(r => r.url)).toEqual(once);
    }
  });
});
