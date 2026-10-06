const Website = require('../models/Website');
const Page = require('../models/Page');
const Term = require('../models/Term');
const Media = require('../models/Media');
const Place = require('../models/Place');
const {
  processHtml,
  extractText,
  calculateFrequencies,
  tokenizeText
} = require('../utils/textProcessor');
const { extractVerticalContent, wordsFromFilename, extractHeadings } = require('./mediaExtractor');
const { config } = require('../config/env');
const { normalizeUrl, hostnameOf } = require('../utils/urlNormalizer');
const openSearchIndexing = require('../services/opensearch/indexingService');
const { MAX_CONTENT_CHARS } = require('../services/opensearch/documentMapper');
const logger = require('../utils/logger');

/**
 * Bounds Page.content to what OpenSearch indexes. The slice matches
 * documentMapper's exactly, so the search document is unchanged by the cap.
 */
function capStoredContent(text) {
  const value = String(text || '');
  return value.length > MAX_CONTENT_CHARS ? value.slice(0, MAX_CONTENT_CHARS) : value;
}

/**
 * Stores a crawled page and updates every index it feeds:
 *
 *   web     Page + Term (inverted index)
 *   images  Media (type: image)
 *   videos  Media (type: video)
 *   news    article fields on Page
 *   maps    Place
 *
 * Index writes use bulk operations instead of two round-trips per unique
 * word, which is the difference between ~4,000 queries and 2 for a typical
 * article. The page's old postings are pulled first, so a re-crawl cannot
 * leave stale terms pointing at content that no longer contains them.
 *
 * @returns {Promise<{ok, pageId?, uniqueTerms?, images?, videos?, places?, error?}>}
 */
async function indexPage(rawUrl, html, metadata = {}) {
  // Store the canonical form, so the same page cannot be saved twice under
  // "https://site.com" and "https://site.com/".
  const url = normalizeUrl(rawUrl);
  if (!url) {
    logger.warn('Refusing to index an invalid URL', { url: String(rawUrl).slice(0, 200) });
    return { ok: false, error: 'Invalid URL' };
  }

  try {
    const domain = hostnameOf(url);

    // 1. Website record for this host.
    let website = await Website.findOne({ domain });
    if (!website) {
      website = await Website.create({ domain, status: 'crawling' });
    }

    // 2. Extract the indexable text once and reuse it for both the stored
    //    body and the token stream.
    //
    //    The title, description and keywords are indexed alongside the body:
    //    a page titled "Tokyo" whose body never repeats the word would
    //    otherwise be unreachable by search. Ranking still adds its separate
    //    title/description bonuses on top of the frequency counted here.
    //
    //    The stored body is capped at the length OpenSearch indexes, so
    //    MongoDB never holds text search cannot see. The token stream below
    //    is built from the full HTML and is unaffected by the cap.
    const textContent = capStoredContent(extractText(html));
    const tokens = [
      ...tokenizeText(metadata.title || ''),
      ...tokenizeText(metadata.description || ''),
      ...tokenizeText(metadata.keywords || ''),
      ...processHtml(html)
    ];
    const frequencies = calculateFrequencies(tokens);

    // Bound pathological pages: keep the highest-frequency terms only.
    const entries = Object.entries(frequencies);
    if (entries.length > config.crawler.maxTermsPerPage) {
      entries.sort((a, b) => b[1] - a[1]);
      entries.length = config.crawler.maxTermsPerPage;
    }

    // 3. Pull out the vertical content in a single extra parse.
    const vertical = extractVerticalContent(html, url, metadata.title || '');

    // 4. Upsert the page. `content` holds extracted visible text (not raw
    //    HTML) so snippets are cheap; snippet generation still strips tags
    //    defensively for rows written before this change.
    const pageData = {
      websiteId: website._id,
      url,
      domain,
      title: metadata.title || '',
      content: textContent,
      description: metadata.description || '',
      keywords: metadata.keywords || '',
      language: metadata.language || '',
      canonicalUrl: metadata.canonicalUrl || '',
      status: 'indexed',
      lastCrawledAt: new Date(),

      // News vertical
      isArticle: Boolean(vertical.article.isArticle),
      publishedAt: vertical.article.publishedAt || null,
      author: vertical.article.author || '',
      section: vertical.article.section || '',
      siteName: vertical.article.siteName || '',
      imageUrl: vertical.article.imageUrl || '',

      imageCount: vertical.images.length,
      videoCount: vertical.videos.length
    };

    const page = await Page.findOneAndUpdate(
      { url },
      { $set: pageData },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    );

    // 5. Index the page for web search.
    //
    //    OpenSearch is the search engine. The MongoDB Term collection is the
    //    superseded inverted index and is only maintained when the rollback
    //    switch (SEARCH_ENGINE=mongo) is set, so the two never run as
    //    competing engines by accident.
    let searchIndexed = false;
    let searchError = '';

    if (config.searchEngine === 'opensearch') {
      const osResult = await openSearchIndexing.indexPage(
        { ...pageData, _id: page._id },
        {
          headings: extractHeadings(html),
          statusCode: metadata.statusCode || 200,
          outboundLinkCount: metadata.outboundLinkCount || 0
        }
      );
      searchIndexed = osResult.ok;
      if (!osResult.ok) {
        searchError = osResult.error || 'unknown';
        // The page is still stored in MongoDB, so a reindex can repair this
        // later; one unreachable cluster must not abort a running crawl.
        logger.warn('Page stored but not search-indexed', { url, reason: searchError });
      }
    } else {
      await rebuildMongoPostings(page._id, entries);
      searchIndexed = true;
    }

    // 6. Vertical indexes.
    const context = {
      pageId: page._id,
      pageUrl: url,
      pageTitle: metadata.title || '',
      domain,
      language: metadata.language || ''
    };

    const [images, videos, places] = await Promise.all([
      indexMedia('image', vertical.images, context),
      indexMedia('video', vertical.videos, context),
      indexPlaces(vertical.places, context)
    ]);

    // 7. Mark the website as having been crawled.
    await Website.updateOne(
      { _id: website._id },
      { $set: { status: 'completed', lastCrawledAt: new Date() } }
    );

    logger.debug('Page indexed', {
      url,
      uniqueTerms: entries.length,
      images,
      videos,
      places,
      isArticle: pageData.isArticle,
      searchIndexed
    });

    return {
      ok: true,
      pageId: page._id.toString(),
      uniqueTerms: entries.length,
      images,
      videos,
      places,
      isArticle: pageData.isArticle,
      searchIndexed,
      searchError
    };
  } catch (error) {
    logger.error('Failed to index page', { url, message: error.message });
    // Record the failure on the page row when we can, so the admin index
    // view shows which URLs are broken.
    try {
      await Page.updateOne({ url }, { $set: { status: 'error' } });
    } catch {
      /* the page may not exist yet */
    }

    return { ok: false, error: error.message };
  }
}

/**
 * Rewrites a page's postings in the legacy MongoDB inverted index.
 *
 * Only reached when SEARCH_ENGINE=mongo. Kept so the rollback switch is a
 * real, working path rather than a promise — but it is not the architecture.
 */
async function rebuildMongoPostings(pageId, entries) {
  await Term.updateMany({ 'documents.pageId': pageId }, { $pull: { documents: { pageId } } });

  if (entries.length === 0) return;

  const operations = entries.map(([word, frequency]) => ({
    updateOne: {
      filter: { word },
      update: {
        $setOnInsert: { word },
        $push: { documents: { pageId, frequency } }
      },
      upsert: true
    }
  }));

  // ordered:false lets independent term writes proceed in parallel and
  // means one duplicate-key race cannot abort the whole batch.
  await Term.bulkWrite(operations, { ordered: false });
}

const MAX_MEDIA_PER_PAGE = 60;

/**
 * Upserts the images or videos found on one page.
 *
 * Media discovered earlier on this page but no longer present is removed, so
 * a re-crawl cannot leave the vertical pointing at content that is gone.
 *
 * @returns {Promise<number>} how many items were indexed
 */
async function indexMedia(type, items, context) {
  // Drop this page's previous media of this type; the loop below re-adds
  // whatever is still there.
  await Media.deleteMany({ pageId: context.pageId, type });

  if (!items || items.length === 0) return 0;

  const capped = items.slice(0, MAX_MEDIA_PER_PAGE);
  const operations = [];

  for (const item of capped) {
    const url = normalizeUrl(item.url);
    if (!url) continue;

    // The searchable text: what the page says about this asset.
    const descriptive = [
      item.alt || '',
      item.caption || '',
      item.title || '',
      wordsFromFilename(url),
      context.pageTitle
    ].join(' ');

    const terms = Array.from(new Set(tokenizeText(descriptive))).slice(0, 60);
    // An asset nothing describes is not findable, so do not index it.
    if (terms.length === 0) continue;

    const title =
      item.alt || item.caption || item.title || wordsFromFilename(url) || context.pageTitle;

    operations.push({
      updateOne: {
        filter: { url },
        update: {
          $set: {
            type,
            url,
            pageId: context.pageId,
            pageUrl: context.pageUrl,
            pageTitle: context.pageTitle,
            domain: context.domain,
            title: String(title).slice(0, 300),
            alt: String(item.alt || '').slice(0, 300),
            caption: String(item.caption || '').slice(0, 500),
            terms,
            width: item.width || null,
            height: item.height || null,
            format: item.format || '',
            provider: item.provider || '',
            providerId: item.providerId || '',
            thumbnailUrl: item.thumbnailUrl || '',
            durationSeconds: item.durationSeconds || null,
            language: context.language,
            lastCrawledAt: new Date()
          }
        },
        upsert: true
      }
    });
  }

  if (operations.length === 0) return 0;

  try {
    await Media.bulkWrite(operations, { ordered: false });
  } catch (error) {
    // A duplicate-key race on `url` is expected when two pages share an
    // asset; other failures are worth logging.
    if (error.code !== 11000) {
      logger.warn('Media index write failed', { type, message: error.message });
    }
  }
  return operations.length;
}

/** Upserts the places found on one page. @returns {Promise<number>} */
async function indexPlaces(places, context) {
  await Place.deleteMany({ pageId: context.pageId });
  if (!places || places.length === 0) return 0;

  const operations = places.slice(0, 20).map(place => {
    const terms = Array.from(
      new Set(tokenizeText(`${place.name} ${place.address} ${place.category} ${context.pageTitle}`))
    ).slice(0, 40);

    return {
      updateOne: {
        filter: { pageId: context.pageId, latitude: place.latitude, longitude: place.longitude },
        update: {
          $set: {
            name: place.name || context.pageTitle,
            latitude: place.latitude,
            longitude: place.longitude,
            location: { type: 'Point', coordinates: [place.longitude, place.latitude] },
            address: place.address || '',
            category: place.category || '',
            pageId: context.pageId,
            pageUrl: context.pageUrl,
            pageTitle: context.pageTitle,
            domain: context.domain,
            terms,
            lastCrawledAt: new Date()
          }
        },
        upsert: true
      }
    };
  });

  try {
    await Place.bulkWrite(operations, { ordered: false });
  } catch (error) {
    if (error.code !== 11000) {
      logger.warn('Place index write failed', { message: error.message });
    }
  }
  return operations.length;
}

/**
 * Removes a page and everything that references it.
 * Used by admin cleanup; never called automatically by the crawler.
 */
async function removePageFromIndex(pageId) {
  await Term.updateMany({ 'documents.pageId': pageId }, { $pull: { documents: { pageId } } });
  // Drop terms that no longer point at any document.
  await Term.deleteMany({ documents: { $size: 0 } });
  // Keep the search index in step: a removed page must stop being findable.
  const page = await Page.findById(pageId).select('url').lean();
  if (page && page.url) await openSearchIndexing.deletePage(page.url);

  await Media.deleteMany({ pageId });
  await Place.deleteMany({ pageId });
  await Page.deleteOne({ _id: pageId });
}

module.exports = { indexPage, removePageFromIndex, indexMedia, indexPlaces, capStoredContent };
