/**
 * The date a page's server says it was last modified (`Last-Modified`), when
 * it says one that can be trusted — otherwise none. Never a stand-in: not
 * the time of the crawl, not the current time.
 *
 * Accepted: an HTTP-date (RFC 9110 §5.6.7) — the IMF-fixdate the standard
 * requires ("Sun, 06 Nov 1994 08:49:37 GMT") and the two obsolete forms it
 * still asks recipients to read (RFC 850 and asctime).
 *
 * Not accepted, so no date:
 *   - a missing or empty header, or one that is not an HTTP-date;
 *   - a date in the future (beyond a minute of clock skew);
 *   - a date before 1990, before the web — a server default, not a page's;
 *   - a date within a minute of the response: a server stamping "now" on a
 *     page it generates says when it answered, not when the page changed.
 */

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

const SKEW_MS = 60 * 1000;
const EARLIEST = Date.UTC(1990, 0, 1);

/**
 * @param {string|string[]|undefined} value  the header as received
 * @param {{fetchedAt?: number}} [options]  when the response arrived (ms)
 * @returns {Date|null}
 */
function parseLastModified(value, { fetchedAt = Date.now() } = {}) {
  // A repeated header is ambiguous: no date.
  if (Array.isArray(value))
    return value.length === 1 ? parseLastModified(value[0], { fetchedAt }) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 64) return null;

  let ms;
  if (IMF_FIXDATE.test(text) || RFC850_DATE.test(text)) {
    ms = Date.parse(text);
  } else if (ASCTIME_DATE.test(text)) {
    // asctime carries no zone; HTTP defines it as GMT.
    ms = Date.parse(`${text.replace(/\s+/g, ' ')} GMT`);
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  // An impossible calendar date ("31 Feb") parses to another day: refused.
  const day = Number(
    /\b(\d{1,2})[ -](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2})\b/
      .exec(text)
      .slice(1)
      .find(Boolean)
  );
  if (new Date(ms).getUTCDate() !== day) return null;

  if (ms < EARLIEST) return null;
  if (ms > fetchedAt + SKEW_MS) return null;
  if (Math.abs(fetchedAt - ms) <= SKEW_MS) return null;
  return new Date(ms);
}

module.exports = { parseLastModified };
