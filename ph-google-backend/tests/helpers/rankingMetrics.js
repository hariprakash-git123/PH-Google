/**
 * Ranking quality measures for the relevance evaluation.
 *
 * Grades are 0 (not relevant) to 3 (the ideal answer). A result counts as
 * relevant for precision and reciprocal rank at grade 2 or more.
 */

const RELEVANT = 2;

/** Share of the first k results that are relevant. */
function precisionAt(grades, k = 10) {
  return grades.slice(0, k).filter(g => g >= RELEVANT).length / k;
}

/** 1 / the position of the first relevant result; 0 when none is. */
function reciprocalRank(grades) {
  const first = grades.findIndex(g => g >= RELEVANT);
  return first === -1 ? 0 : 1 / (first + 1);
}

const dcg = grades => grades.reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);

/**
 * nDCG@k: the order's gain over the best order of the same candidates.
 *
 * @param {number[]} grades  the grades in the order shown
 * @param {number[]} pool    every candidate's grade (the ideal is their best order)
 */
function ndcgAt(grades, pool, k = 10) {
  const ideal = dcg([...pool].sort((a, b) => b - a).slice(0, k));
  return ideal === 0 ? 0 : dcg(grades.slice(0, k)) / ideal;
}

const mean = values => values.reduce((s, v) => s + v, 0) / (values.length || 1);

module.exports = { precisionAt, reciprocalRank, ndcgAt, mean, RELEVANT };
