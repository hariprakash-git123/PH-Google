import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertCircle
} from 'lucide-react';
import { searchApi } from '../../services/searchApi';
import { safeHttpUrl } from '../../utils/safeUrl';
import './AIAnswer.css';

/**
 * The AI answer shown above the web results.
 *
 * It is written by the backend from the documents the search retrieved, and
 * everything rendered here comes from that response: the text, the citation
 * numbers and the sources they point at. Nothing is generated in the browser.
 *
 * The component never blocks the page. It loads after the results are on
 * screen, and every way it can fail — no sources, not enough evidence, the
 * model being down — ends in a short note above results that still work.
 */

/** Longer answers start collapsed so they do not push the results down. */
const COLLAPSE_AT_CHARS = 420;
const COLLAPSED_KEY_POINTS = 3;

const NO_SOURCES_MESSAGE = 'No reliable sources were found for an AI answer.';
const UNAVAILABLE_MESSAGE = 'AI answer is temporarily unavailable.';

/**
 * Renders answer text, turning each [n] into a link to source n.
 * A number with no matching source — or one whose address is not a safe web
 * link — is dropped rather than shown as a dead marker.
 */
function CitedText({ text, sourcesByIndex }) {
  const parts = String(text || '').split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (!match) return part ? <span key={i}>{part}</span> : null;

    const source = sourcesByIndex.get(Number(match[1]));
    const href = source ? safeHttpUrl(source.url) : null;
    if (!href) return null;
    return (
      <sup key={i} className="ph-ai-cite-wrap">
        <a
          className="ph-ai-cite"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Source ${source.index}: ${source.title}`}
          title={source.title}
        >
          {source.index}
        </a>
      </sup>
    );
  });
}

/** Plain text for the clipboard: the answer, its points and its sources. */
function toClipboardText(data) {
  const lines = [data.answer];
  if (data.keyPoints.length > 0) {
    lines.push('', ...data.keyPoints.map(point => `• ${point}`));
  }
  if (data.sources.length > 0) {
    lines.push('', 'Sources:', ...data.sources.map(s => `[${s.index}] ${s.title} — ${s.url}`));
  }
  return lines.join('\n');
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Older browsers and non-secure origins have no clipboard API.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  if (!ok) throw new Error('Copy is not available in this browser.');
}

function Shell({ children, quiet = false, busy = false }) {
  return (
    <section
      className={`ph-ai-answer-card ${quiet ? 'ph-ai-answer-card-quiet' : ''} animate-fade-in`}
      aria-label="AI answer"
      aria-busy={busy}
    >
      <div className="ph-ai-answer-header">
        <div className="ph-ai-title-wrap">
          <div className="ph-ai-badge-icon" aria-hidden="true">
            <Sparkles size={16} />
          </div>
          <div>
            <div className="ph-ai-tag">PH AI Answer</div>
            <h3 className="ph-ai-heading">Quick answer</h3>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function AIAnswer({ query, filters = {}, hasResults = true }) {
  const { domain = '', date = '', language = '' } = filters;

  const [state, setState] = useState({ loading: hasResults, data: null });
  // What is being answered. "Regenerate" asks again for this same question,
  // bypassing the server's cache; a new question never does.
  const questionKey = [query, domain, date, language].join('\u0000');
  const [attempt, setAttempt] = useState({ id: 0, key: null });
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [rating, setRating] = useState(null);
  const copyTimer = useRef(null);

  useEffect(() => {
    // With nothing retrieved there is nothing to answer from: do not ask.
    if (!query || !hasResults) {
      setState({ loading: false, data: null });
      return undefined;
    }

    const controller = new AbortController();
    setState({ loading: true, data: null });
    setExpanded(false);
    setRating(null);
    setCopied(false);
    setCopyFailed(false);

    searchApi
      .getAiAnswer(
        query,
        { domain, date, language },
        { signal: controller.signal, refresh: attempt.id > 0 && attempt.key === questionKey }
      )
      .then(data => {
        if (!controller.signal.aborted) setState({ loading: false, data });
      })
      .catch(error => {
        if (error.name === 'AbortError' || controller.signal.aborted) return;
        setState({
          loading: false,
          data: { status: 'unavailable', message: UNAVAILABLE_MESSAGE, sources: [], keyPoints: [] }
        });
      });

    return () => controller.abort();
  }, [query, domain, date, language, hasResults, attempt, questionKey]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const data = state.data;
  const sources = useMemo(
    () => (data && Array.isArray(data.sources) ? data.sources : []).filter(s => safeHttpUrl(s.url)),
    [data]
  );
  const sourcesByIndex = useMemo(() => new Map(sources.map(s => [s.index, s])), [sources]);

  if (!query) return null;

  if (!hasResults) {
    return (
      <Shell quiet>
        <p className="ph-ai-note" role="status">
          {NO_SOURCES_MESSAGE}
        </p>
      </Shell>
    );
  }

  if (state.loading) {
    return (
      <Shell busy>
        <p className="ph-ai-loading-label" role="status">
          Generating answer…
        </p>
        <div className="ph-ai-skeleton animate-pulse" aria-hidden="true">
          <div className="ph-ai-skeleton-line" />
          <div className="ph-ai-skeleton-line" />
          <div className="ph-ai-skeleton-line ph-ai-skeleton-line-short" />
        </div>
      </Shell>
    );
  }

  if (!data || data.status === 'disabled') return null;

  const regenerate = () => setAttempt(prev => ({ id: prev.id + 1, key: questionKey }));

  if (data.status !== 'ok') {
    const isFailure = data.status === 'unavailable';
    const message =
      data.status === 'no_results'
        ? NO_SOURCES_MESSAGE
        : data.message || (isFailure ? UNAVAILABLE_MESSAGE : NO_SOURCES_MESSAGE);
    return (
      <Shell quiet>
        <p className="ph-ai-note" role={isFailure ? 'alert' : 'status'}>
          {isFailure && <AlertCircle size={15} aria-hidden="true" />}
          <span>{message}</span>
        </p>
        {isFailure && (
          <div className="ph-ai-actions">
            <button type="button" className="ph-ai-action" onClick={regenerate}>
              <RefreshCw size={14} aria-hidden="true" />
              <span>Try again</span>
            </button>
          </div>
        )}
      </Shell>
    );
  }

  const keyPoints = Array.isArray(data.keyPoints) ? data.keyPoints : [];
  const collapsible =
    String(data.answer).length > COLLAPSE_AT_CHARS || keyPoints.length > COLLAPSED_KEY_POINTS;
  const collapsed = collapsible && !expanded;
  const visiblePoints = collapsed ? keyPoints.slice(0, COLLAPSED_KEY_POINTS) : keyPoints;

  const handleCopy = async () => {
    clearTimeout(copyTimer.current);
    try {
      await copyText(toClipboardText({ ...data, keyPoints, sources }));
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2500);
  };

  const handleRate = async value => {
    if (rating === value) return;
    const previous = rating;
    setRating(value);
    const stored = await searchApi.sendAiFeedback({
      answerId: data.answerId,
      query: data.query || query,
      rating: value,
      model: data.model,
      provider: data.provider
    });
    if (!stored) setRating(previous);
  };

  return (
    <Shell>
      <div
        id="ph-ai-answer-body"
        className={`ph-ai-answer-body ${collapsed ? 'ph-ai-answer-body-collapsed' : ''}`}
      >
        <p className="ph-ai-answer-text">
          <CitedText text={data.answer} sourcesByIndex={sourcesByIndex} />
        </p>

        {visiblePoints.length > 0 && (
          <div className="ph-ai-points">
            <h4 className="ph-ai-subheading">Key points</h4>
            <ul className="ph-ai-points-list">
              {visiblePoints.map((point, i) => (
                <li key={i}>
                  <CitedText text={point} sourcesByIndex={sourcesByIndex} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {collapsible && (
        <button
          type="button"
          className="ph-ai-expand"
          aria-expanded={expanded}
          aria-controls="ph-ai-answer-body"
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? (
            <ChevronUp size={15} aria-hidden="true" />
          ) : (
            <ChevronDown size={15} aria-hidden="true" />
          )}
          <span>{expanded ? 'Show less' : 'Show more'}</span>
        </button>
      )}

      {sources.length > 0 && (
        <div className="ph-ai-sources">
          <h4 className="ph-ai-subheading">Sources</h4>
          <ol className="ph-ai-sources-list">
            {sources.map(source => (
              <li key={source.index} className="ph-ai-source">
                <span className="ph-ai-source-index" aria-hidden="true">
                  {source.index}
                </span>
                <a
                  className="ph-ai-source-link"
                  href={safeHttpUrl(source.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="ph-ai-source-title">{source.title}</span>
                  <span className="ph-ai-source-domain">{source.domain}</span>
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="ph-ai-footer">
        <p className="ph-ai-disclaimer">
          Generated from the sources above. Check them for anything important.
        </p>
        <div className="ph-ai-actions">
          <button type="button" className="ph-ai-action" onClick={handleCopy}>
            {copied ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
            <span>{copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy'}</span>
          </button>
          <button type="button" className="ph-ai-action" onClick={regenerate}>
            <RefreshCw size={14} aria-hidden="true" />
            <span>Regenerate</span>
          </button>
          <span className="ph-ai-feedback" role="group" aria-label="Rate this answer">
            <button
              type="button"
              className={`ph-ai-action ph-ai-action-icon ${rating === 'up' ? 'is-active' : ''}`}
              aria-label="Helpful"
              aria-pressed={rating === 'up'}
              onClick={() => handleRate('up')}
            >
              <ThumbsUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`ph-ai-action ph-ai-action-icon ${rating === 'down' ? 'is-active' : ''}`}
              aria-label="Not helpful"
              aria-pressed={rating === 'down'}
              onClick={() => handleRate('down')}
            >
              <ThumbsDown size={14} aria-hidden="true" />
            </button>
          </span>
          {rating && (
            <span className="ph-ai-feedback-thanks" role="status">
              Thanks for the feedback.
            </span>
          )}
        </div>
      </div>
    </Shell>
  );
}
