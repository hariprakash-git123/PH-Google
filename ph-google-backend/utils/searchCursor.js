const crypto = require('crypto');
const { ApiError } = require('./apiResponse');
const { config } = require('../config/env');

/**
 * The "Load more" cursor: where the next batch of a search starts.
 *
 * Opaque to the browser (base64url JSON), and nothing in it is trusted:
 * every field is checked here, and a cursor made for one search is refused
 * for another. It carries offsets, not results, so it cannot be used to make
 * the server show something a search did not find.
 *
 *   k  which search it belongs to: a hash of the query, tab and filters
 *   o  offset into the source's own ranked list (the index's, or a vertical's)
 *   e  how many external web results have been shown so far (All tab)
 *   p  how external results continue: "ranked" — each batch shares both
 *      sources, ranked together (unifiedRanker); "external" — the index did
 *      not answer the query, so the provider's answer fills batches first,
 *      still ranked. "first"/"after" from older cursors continue as
 *      "external"/"ranked"
 *   x  1 while the external answer may still have results not yet shown
 *   r  Images/Videos from Parallel: how many rounds of requests the list is
 *      made of so far (see parallelVerticals.js — Parallel has no paging,
 *      so "more" is a further round asked a different way)
 */

const VERSION = 1;
/** An external answer is at most a few dozen results; an offset past this is not real. */
const MAX_EXTERNAL_OFFSET = 200;
/** More rounds than any vertical asks for are not real. */
const MAX_ROUNDS = 10;

/** Which search a cursor belongs to. */
function searchKey({ query, category, sort, domain, dateWindow, language }) {
  const canonical = JSON.stringify([
    String(query || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' '),
    category || 'all',
    sort || 'relevance',
    domain || '',
    dateWindow || 'any',
    language || ''
  ]);
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

/**
 * @param {Object} search     what searchKey takes
 * @param {{offset: number, externalOffset?: number, placement?: string|null,
 *          externalMore?: boolean, rounds?: number}} state
 * @returns {string}
 */
function encodeCursor(
  search,
  { offset, externalOffset = 0, placement = null, externalMore = false, rounds = 0 }
) {
  const body = { v: VERSION, k: searchKey(search), o: offset, e: externalOffset };
  if (placement) body.p = placement;
  if (externalMore) body.x = 1;
  if (rounds > 0) body.r = rounds;
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

const isCount = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

/**
 * @param {string} raw
 * @param {Object} search  the request's own query, tab and filters
 * @returns {{offset: number, externalOffset: number, placement: string|null,
 *            externalMore: boolean, rounds: number}}
 * @throws {ApiError} 400 for anything that is not a cursor of this search
 */
function decodeCursor(raw, search) {
  const invalid = () => ApiError.badRequest('Invalid "cursor" parameter.');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) throw invalid();
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();

  let body;
  try {
    body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.v !== VERSION) {
    throw invalid();
  }
  if (body.k !== searchKey(search)) {
    throw ApiError.badRequest(
      'The "cursor" belongs to a different search. Start the search again.'
    );
  }
  if (!isCount(body.o, config.search.maxResultWindow)) throw invalid();
  if (!isCount(body.e ?? 0, MAX_EXTERNAL_OFFSET)) throw invalid();
  // 'ranked'/'external' since the merged ranking; 'first'/'after' from older cursors.
  if (body.p !== undefined && !['first', 'after', 'ranked', 'external'].includes(body.p)) {
    throw invalid();
  }
  if (body.x !== undefined && body.x !== 1) throw invalid();
  if (body.r !== undefined && (!isCount(body.r, MAX_ROUNDS) || body.r === 0)) throw invalid();

  return {
    offset: body.o,
    externalOffset: body.e ?? 0,
    placement: body.p || null,
    externalMore: body.x === 1,
    rounds: body.r ?? 0
  };
}

module.exports = { encodeCursor, decodeCursor, searchKey, MAX_EXTERNAL_OFFSET, MAX_ROUNDS };
