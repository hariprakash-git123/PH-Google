const { config } = require('../../config/env');
const { getSynonyms } = require('./synonyms');

/**
 * Index settings and mappings for the web-page index.
 *
 * Analyzer strategy
 * -----------------
 * Three analyzers, each with a different job, so one can be strict while
 * another is forgiving:
 *
 *   ph_text      indexing + general matching. Lowercase, ASCII-folded,
 *                English stop words, light stemming (porter-ish via
 *                kstem, which is far less destructive than porter_stem).
 *
 *   ph_exact     lowercase + ASCII-fold only. No stemming, no stop-word
 *                removal. This is what preserves technical terms and names:
 *                "react" stays "react", "SQL" stays "sql", and a quoted
 *                phrase matches what the user actually typed.
 *
 *   ph_search    ph_text plus synonym expansion. Applied at search time
 *                only, so editing synonyms.js never requires a reindex.
 *
 * Why kstem rather than porter_stem: porter turns "universal", "universe"
 * and "university" into "univers", which is exactly the kind of collapse
 * that makes a search engine feel wrong. kstem is dictionary-based and
 * conservative.
 *
 * Every full-text field carries an `.exact` sub-field so a query can ask for
 * a stemmed match and an unstemmed one separately and score them differently.
 */

/** Non-scoring stop words — used for the text analyzer only. */
const STOP_WORDS = '_english_';

function buildSettings() {
  return {
    index: {
      number_of_shards: config.opensearch.numberOfShards,
      number_of_replicas: config.opensearch.numberOfReplicas,
      // A laptop does not need near-real-time refresh on every write; 1s is
      // the default and is fine, but bulk indexing overrides it temporarily.
      refresh_interval: '1s',
      // Long documents still need term positions for phrase queries.
      'mapping.total_fields.limit': 200
    },
    analysis: {
      filter: {
        ph_english_stop: {
          type: 'stop',
          stopwords: STOP_WORDS
        },
        // Conservative, dictionary-based stemming.
        ph_stemmer: {
          type: 'kstem'
        },
        // Search-time only, so synonyms can be edited without reindexing.
        ph_synonyms: {
          type: 'synonym_graph',
          lenient: true,
          synonyms: getSynonyms()
        },
        // Splits "OpenSearch" -> open, search and "wi-fi" -> wi, fi while
        // keeping the original token, so both spellings match.
        ph_word_delimiter: {
          type: 'word_delimiter_graph',
          generate_word_parts: true,
          generate_number_parts: true,
          catenate_words: false,
          catenate_numbers: false,
          split_on_case_change: true,
          split_on_numerics: true,
          preserve_original: true,
          stem_english_possessive: true
        }
      },

      analyzer: {
        // Indexing + general matching.
        ph_text: {
          type: 'custom',
          tokenizer: 'standard',
          filter: [
            'lowercase',
            'asciifolding',
            'ph_word_delimiter',
            'ph_english_stop',
            'ph_stemmer'
          ]
        },

        // Exact-ish: preserves the user's words. No stemming, no stop removal.
        ph_exact: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding']
        },

        // Search-time analyzer for ph_text fields: adds synonyms.
        //
        // Order matters. The filters *before* synonym_graph are also used to
        // parse the synonym list itself, and OpenSearch refuses graph filters
        // in that position ("cannot be used to parse synonyms"). So synonyms
        // sit directly after the two simple normalising filters, and the
        // word-delimiter/stop/stemmer chain runs on the expanded result.
        ph_search: {
          type: 'custom',
          tokenizer: 'standard',
          filter: [
            'lowercase',
            'asciifolding',
            'ph_synonyms',
            'ph_word_delimiter',
            'ph_english_stop',
            'ph_stemmer'
          ]
        },

        // Splits a URL into searchable path segments:
        // "https://react.dev/learn/thinking-in-react"
        //   -> react, dev, learn, thinking, in, react
        ph_url: {
          type: 'custom',
          tokenizer: 'standard',
          char_filter: ['ph_url_cleaner'],
          filter: ['lowercase', 'asciifolding']
        }
      },

      char_filter: {
        ph_url_cleaner: {
          type: 'pattern_replace',
          // Turn scheme, separators and the common "www." into spaces so the
          // tokenizer sees words rather than one long token.
          pattern: '(https?://|www\\.|[/._\\-?=&#+])',
          replacement: ' '
        }
      },

      normalizer: {
        // For keyword fields that should compare case-insensitively
        // (domain names are case-insensitive by definition).
        ph_lowercase: {
          type: 'custom',
          filter: ['lowercase']
        }
      }
    }
  };
}

/**
 * Field mappings.
 *
 * text     -> analyzed, drives relevance
 * keyword  -> exact values, used for filters, aggregations and sorting
 * date     -> range filters and recency scoring
 * numeric  -> quality signals and range filters
 *
 * `index: false` marks fields that are stored for display but never queried,
 * so they cost nothing at query time.
 */
const MAPPINGS = {
  // Unknown fields should be an error in development rather than silently
  // creating a badly-typed field.
  dynamic: 'strict',

  properties: {
    // --- Identity -------------------------------------------------
    pageId: { type: 'keyword' }, // the MongoDB _id, for joins

    url: {
      type: 'text',
      analyzer: 'ph_url',
      fields: {
        raw: { type: 'keyword', ignore_above: 2048 } // exact URL lookup
      }
    },
    canonicalUrl: { type: 'keyword', ignore_above: 2048 },
    // Hash of the normalised URL — the deduplication key.
    urlHash: { type: 'keyword' },
    // Hash of the body text — catches the same content on different URLs.
    contentHash: { type: 'keyword' },

    domain: {
      type: 'keyword',
      normalizer: 'ph_lowercase',
      fields: {
        // So "react dev" can match the domain react.dev as free text.
        text: { type: 'text', analyzer: 'ph_url' }
      }
    },
    // example.com from www.blog.example.com — for site-level grouping.
    rootDomain: { type: 'keyword', normalizer: 'ph_lowercase' },
    path: { type: 'text', analyzer: 'ph_url' },

    // --- Searchable content ---------------------------------------
    title: {
      type: 'text',
      analyzer: 'ph_text',
      search_analyzer: 'ph_search',
      fields: {
        // Unstemmed — scores literal wording above a stemmed near-match.
        exact: { type: 'text', analyzer: 'ph_exact' },
        // Whole-title equality, for "did they search this exact title?".
        raw: { type: 'keyword', ignore_above: 512, normalizer: 'ph_lowercase' }
      }
    },

    description: {
      type: 'text',
      analyzer: 'ph_text',
      search_analyzer: 'ph_search',
      fields: {
        exact: { type: 'text', analyzer: 'ph_exact' }
      }
    },

    headings: {
      type: 'text',
      analyzer: 'ph_text',
      search_analyzer: 'ph_search',
      fields: {
        exact: { type: 'text', analyzer: 'ph_exact' }
      }
    },

    content: {
      type: 'text',
      analyzer: 'ph_text',
      search_analyzer: 'ph_search',
      fields: {
        exact: { type: 'text', analyzer: 'ph_exact' }
      }
    },

    keywords: {
      type: 'text',
      analyzer: 'ph_text',
      search_analyzer: 'ph_search'
    },

    // --- Filters ---------------------------------------------------
    language: { type: 'keyword', normalizer: 'ph_lowercase' },
    country: { type: 'keyword', normalizer: 'ph_lowercase' },
    contentType: { type: 'keyword' },
    statusCode: { type: 'short' },

    // --- Dates -----------------------------------------------------
    publishedAt: { type: 'date' },
    updatedAt: { type: 'date' },
    // The source's own Last-Modified header, when it gave a credible one.
    // Added to an existing index by ensureIndex (additive, no reindex).
    modifiedAt: { type: 'date' },
    crawledAt: { type: 'date' },

    // --- Quality / ranking signals ---------------------------------
    wordCount: { type: 'integer' },
    // Distinct words / total words. A page repeating one phrase thousands of
    // times scores low here, which is how keyword stuffing is demoted.
    uniqueWordRatio: { type: 'half_float' },
    titleLength: { type: 'short' },
    hasDescription: { type: 'boolean' },
    outboundLinkCount: { type: 'integer' },
    imageCount: { type: 'integer' },
    videoCount: { type: 'integer' },
    // 0..1, computed at index time from the signals above.
    qualityScore: { type: 'half_float' },
    isArticle: { type: 'boolean' },

    // --- News vertical ---------------------------------------------
    author: { type: 'keyword', ignore_above: 256 },
    section: { type: 'keyword', ignore_above: 128 },
    siteName: { type: 'keyword', ignore_above: 256 },
    imageUrl: { type: 'keyword', index: false, ignore_above: 2048 }
  }
};

/** The full create-index body. */
function buildIndexDefinition() {
  return {
    settings: buildSettings(),
    mappings: MAPPINGS
  };
}

module.exports = {
  buildIndexDefinition,
  buildSettings,
  MAPPINGS,
  STOP_WORDS
};
