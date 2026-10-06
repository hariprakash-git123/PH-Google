const { normalizeUrl, canonicalKey } = require('../utils/urlNormalizer');

/**
 * In-memory frontier for one crawl run.
 *
 * Owns both the pending list and the visited set, so each crawl gets a fresh
 * instance. (A shared module-level queue would make a second crawl skip every
 * URL the first one had already seen.)
 */
class UrlQueue {
  constructor() {
    this.queue = [];
    this.visited = new Set();
    this.discovered = 0;
  }

  /**
   * Canonicalises a URL so the same page is not crawled twice.
   * Delegates to the shared normalizer so the frontier and the stored
   * Page.url can never disagree.
   *
   * @returns {string|null} normalised absolute URL, or null when invalid
   */
  normalize(url) {
    return normalizeUrl(url);
  }

  /**
   * Adds a URL if it has not been seen before.
   * @returns {boolean} true when the URL was newly enqueued
   */
  enqueue(url, depth = 0) {
    const clean = this.normalize(url);
    if (!clean) return false;
    // Seen-ness is judged by canonical key, the identity the durable frontier
    // and the OpenSearch document id use, so "/page" and
    // "/page?utm_source=x" are one visit here as they are everywhere else.
    const key = canonicalKey(clean);
    if (this.visited.has(key)) return false;

    this.visited.add(key);
    this.queue.push({ url: clean, depth });
    this.discovered += 1;
    return true;
  }

  /** @returns {{url: string, depth: number}|undefined} */
  dequeue() {
    return this.queue.shift();
  }

  /** True when this URL has already been enqueued during this run. */
  hasSeen(url) {
    const clean = this.normalize(url);
    return clean ? this.visited.has(canonicalKey(clean)) : false;
  }

  isEmpty() {
    return this.queue.length === 0;
  }

  size() {
    return this.queue.length;
  }

  /** Total distinct URLs discovered during this run. */
  discoveredCount() {
    return this.discovered;
  }
}

module.exports = UrlQueue;
