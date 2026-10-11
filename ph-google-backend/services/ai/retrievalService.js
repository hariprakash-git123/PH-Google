const mongoose = require('mongoose');
const searchDispatcher = require('../searchDispatcher');
const { getClient } = require('../opensearch/client');
const Page = require('../../models/Page');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');
const { parseQuery } = require('../opensearch/queryParser');
const { languageCompatible, wantedScript } = require('../ranking/unifiedRanker');

/**
 * Retrieval for AI answers.
 *
 * There is one search engine in this application and this module does not
 * add a second: candidates come from `searchDispatcher.webSearch`, the same
 * call that fills the results page, so an answer is built from exactly the
 * documents — parsed, ranked and de-duplicated the same way — that the user
 * sees listed underneath it.
 *
 * A search result carries a snippet, not the page text, so the text of the
 * chosen documents is then read from wherever the active engine keeps it:
 * the OpenSearch index, or the Page collection on the legacy engine.
 *
 * Swapping in semantic or hybrid retrieval later means changing `retrieve`
 * here; the context builder downstream only needs ranked documents with text.
 */

const TEXT_FIELDS = ['content', 'description', 'headings', 'contentHash', 'wordCount'];

/** Page text for OpenSearch document ids, keyed by id. */
async function loadFromOpenSearch(ids) {
  const response = await getClient().mget({
    index: config.opensearch.index,
    body: { ids },
    _source: TEXT_FIELDS
  });
  const texts = new Map();
  for (const doc of response?.body?.docs || []) {
    if (doc && doc.found && doc._source) texts.set(doc._id, doc._source);
  }
  return texts;
}

/** Page text for Page ids (the legacy engine's result ids), keyed by id. */
async function loadFromMongo(ids) {
  const valid = ids.filter(id => mongoose.isValidObjectId(id));
  if (valid.length === 0) return new Map();
  const pages = await Page.find({ _id: { $in: valid } })
    .select('content description')
    .lean();
  return new Map(
    pages.map(p => [String(p._id), { content: p.content, description: p.description }])
  );
}

async function loadTexts(ids) {
  if (ids.length === 0) return new Map();
  try {
    return searchDispatcher.usingOpenSearch()
      ? await loadFromOpenSearch(ids)
      : await loadFromMongo(ids);
  } catch (error) {
    // The snippets are still usable evidence, so a failed text lookup
    // degrades the answer rather than failing it.
    logger.warn('AI answer could not load page text; using snippets only', {
      message: error.message
    });
    return new Map();
  }
}

/**
 * Drops candidates that match far worse than the best one.
 *
 * Taking "the first N" would hand the model whatever fills the list, and a
 * weak match reads as evidence when it is not. Scores are only comparable
 * within one search, hence a share of the top score rather than a fixed bar.
 */
function keepRelevant(results, minRelativeScore) {
  const top = results.reduce((max, r) => Math.max(max, Number(r.score) || 0), 0);
  if (top <= 0) return results;
  const floor = top * minRelativeScore;
  return results.filter(r => (Number(r.score) || 0) >= floor);
}

/**
 * @param {Object} params
 * @param {string} params.query
 * @param {string} [params.domain]
 * @param {string} [params.language]
 * @param {string} [params.dateWindow]
 * @param {number} [params.count]  candidates to fetch
 * @returns {Promise<{documents: Array<Object>, totalResults: number,
 *                    retrieved: number, engine: string, responseTimeMs: number}>}
 */
async function retrieve({ query, domain = '', language = '', dateWindow = 'any', count }) {
  const startedAt = Date.now();
  const limit = count || config.ai.retrievalCount;

  // Index results only: answers are written from page text the index holds,
  // and external search results carry a snippet, not a page.
  const outcome = await searchDispatcher.webSearch(
    {
      query,
      page: 1,
      limit,
      sort: 'relevance',
      domain,
      dateWindow,
      language
    },
    { includeExternal: false }
  );

  // Only entries that are usable search results: an object with an id and a url.
  const results = (Array.isArray(outcome && outcome.results) ? outcome.results : []).filter(
    r =>
      r && typeof r === 'object' && r.id !== undefined && r.id !== null && typeof r.url === 'string'
  );
  // An answer to a question asked in one language is written from pages in
  // a compatible one: a Japanese article is not evidence for an English
  // question, however well it matches its words. Unless a language was asked
  // for (the filter, lang:), which the search has already applied.
  const script = wantedScript(parseQuery(query), { language });
  const readable = results.filter(r => languageCompatible(r, script));
  const relevant = keepRelevant(readable, config.ai.minRelativeScore);
  const texts = await loadTexts(relevant.map(r => String(r.id)));

  const documents = relevant.map(result => {
    const text = texts.get(String(result.id)) || {};
    // "No description available." is the search page's placeholder, not evidence.
    const snippet = result.snippet === 'No description available.' ? '' : result.snippet || '';
    return {
      id: result.id,
      url: result.url,
      title: result.title,
      domain: result.domain,
      snippet,
      score: result.score,
      publishedAt: result.publishedAt || null,
      crawledAt: result.crawledAt || null,
      // With no stored text the snippet is all there is to read.
      content: text.content || snippet,
      description: text.description || '',
      contentHash: text.contentHash || ''
    };
  });

  return {
    documents,
    totalResults: (outcome && outcome.totalResults) || 0,
    retrieved: results.length,
    engine: (outcome && outcome.engine) || config.searchEngine,
    responseTimeMs: Date.now() - startedAt
  };
}

module.exports = { retrieve, keepRelevant };
