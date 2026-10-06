import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AIAnswer from './AIAnswer';
import { searchApi } from '../../services/searchApi';

/**
 * The AI answer component, against a stubbed API layer.
 *
 * `searchApi` is the only thing replaced: each test decides what the backend
 * "returned" and checks what the reader sees and can do.
 */

vi.mock('../../services/searchApi', () => ({
  searchApi: {
    getAiAnswer: vi.fn(),
    sendAiFeedback: vi.fn()
  }
}));

const SOURCES = [
  {
    index: 1,
    title: 'About OpenSearch',
    url: 'https://opensearch.org/docs/about',
    domain: 'opensearch.org',
    snippet: 'OpenSearch is an open-source search and analytics suite.',
    relevanceScore: 12.5
  },
  {
    index: 2,
    title: 'OpenSearch - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/OpenSearch',
    domain: 'en.wikipedia.org',
    snippet: 'A fork of Elasticsearch.',
    relevanceScore: 9.1
  }
];

const answer = (overrides = {}) => ({
  answerId: '3f2b8c1e-9d4a-4b7e-8a11-5c6d7e8f9a0b',
  query: 'What is OpenSearch?',
  intent: 'definition',
  status: 'ok',
  generated: true,
  answer:
    'OpenSearch is an open-source search and analytics suite [1]. It began as a fork of Elasticsearch [2].',
  summary: 'OpenSearch is an open-source search and analytics suite.',
  keyPoints: ['Distributed full-text search [1]', 'Apache 2.0 licence [2]'],
  sources: SOURCES,
  message: null,
  reason: null,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  cached: false,
  ...overrides
});

const renderAnswer = (props = {}) =>
  render(<AIAnswer query="What is OpenSearch?" filters={{}} hasResults {...props} />);

/** A promise the test resolves when it chooses. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  searchApi.getAiAnswer.mockReset();
  searchApi.sendAiFeedback.mockReset();
  searchApi.getAiAnswer.mockResolvedValue(answer());
  searchApi.sendAiFeedback.mockResolvedValue(true);
});

// ----------------------------------------------------------------------
describe('loading', () => {
  it('shows a loading state while the answer is being generated', async () => {
    const pending = deferred();
    searchApi.getAiAnswer.mockReturnValue(pending.promise);
    renderAnswer();

    expect(screen.getByText('Generating answer…')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'AI answer' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/open-source search and analytics suite/)).not.toBeInTheDocument();

    pending.resolve(answer());
    expect(await screen.findByText(/open-source search and analytics suite/)).toBeInTheDocument();
    expect(screen.queryByText('Generating answer…')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'AI answer' })).toHaveAttribute('aria-busy', 'false');
  });

  it('asks the backend for the query and filters it was given', async () => {
    renderAnswer({ filters: { domain: 'opensearch.org', date: 'Past week', language: 'English' } });
    await screen.findByText(/open-source search and analytics suite/);

    expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(1);
    const [query, filters, options] = searchApi.getAiAnswer.mock.calls[0];
    expect(query).toBe('What is OpenSearch?');
    expect(filters).toEqual({ domain: 'opensearch.org', date: 'Past week', language: 'English' });
    expect(options.refresh).toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

// ----------------------------------------------------------------------
describe('an answer', () => {
  it('renders the heading, the answer and the key points', async () => {
    renderAnswer();

    expect(await screen.findByText('PH AI Answer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quick answer' })).toBeInTheDocument();
    expect(
      screen.getByText(/OpenSearch is an open-source search and analytics suite/)
    ).toBeInTheDocument();
    expect(screen.getByText(/It began as a fork of Elasticsearch/)).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Key points' })).toBeInTheDocument();
    expect(screen.getByText(/Distributed full-text search/)).toBeInTheDocument();
    expect(screen.getByText(/Apache 2\.0 licence/)).toBeInTheDocument();
  });

  it('renders the sources from the backend, each linking to its real address', async () => {
    renderAnswer();
    const sourcesHeading = await screen.findByRole('heading', { name: 'Sources' });
    const sourcesBlock = sourcesHeading.parentElement;
    const links = within(sourcesBlock).getAllByRole('link');

    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', 'https://opensearch.org/docs/about');
    expect(links[0]).toHaveTextContent('About OpenSearch');
    expect(links[0]).toHaveTextContent('opensearch.org');
    expect(links[1]).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/OpenSearch');
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('turns each [n] in the text into a link to source n', async () => {
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);

    const first = screen.getAllByRole('link', { name: 'Source 1: About OpenSearch' });
    const second = screen.getAllByRole('link', { name: 'Source 2: OpenSearch - Wikipedia' });
    // Once in the answer and once in a key point, for each source.
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0]).toHaveAttribute('href', 'https://opensearch.org/docs/about');
    expect(first[0]).toHaveAttribute('target', '_blank');
    expect(first[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(first[0]).toHaveTextContent('1');
    expect(second[0]).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/OpenSearch');

    // The raw markers are gone from the visible text.
    expect(screen.queryByText(/\[1\]/)).not.toBeInTheDocument();
  });

  it('drops a citation number that has no source', async () => {
    searchApi.getAiAnswer.mockResolvedValue(
      answer({ answer: 'A real claim [1]. A stray marker [9].', keyPoints: [] })
    );
    renderAnswer();
    await screen.findByText(/A real claim/);

    expect(screen.getAllByRole('link', { name: /^Source 1:/ })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /^Source 9/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/\[9\]/)).not.toBeInTheDocument();
  });

  it('never links to an address that is not http or https', async () => {
    searchApi.getAiAnswer.mockResolvedValue(
      answer({
        answer: 'Claim one [1]. Claim two [2]. Claim three [3].',
        keyPoints: [],
        sources: [
          { index: 1, title: 'Script link', url: 'javascript:alert(document.cookie)', domain: 'x' },
          {
            index: 2,
            title: 'Data link',
            url: 'data:text/html,<script>alert(1)</script>',
            domain: 'y'
          },
          {
            index: 3,
            title: 'Good link',
            url: 'https://good.example.com/page',
            domain: 'good.example.com'
          }
        ]
      })
    );
    renderAnswer();
    await screen.findByText(/Claim one/);

    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^https:\/\/good\.example\.com\//);
    expect(screen.queryByText('Script link')).not.toBeInTheDocument();
    expect(screen.queryByText('Data link')).not.toBeInTheDocument();
    expect(screen.getByText('Good link')).toBeInTheDocument();
  });

  it('shows answer text as text, never as markup', async () => {
    searchApi.getAiAnswer.mockResolvedValue(
      answer({
        answer: 'Safe <img src=x onerror="alert(1)"> text <script>alert(2)</script> [1].',
        keyPoints: ['<b>bold?</b> [1]'],
        sources: [{ ...SOURCES[0], title: '<i>Title</i>' }]
      })
    );
    const { container } = renderAnswer();
    await screen.findByText(/Safe <img/);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(screen.getByText('<i>Title</i>')).toBeInTheDocument();
  });

  it('shows no key points section when there are none', async () => {
    searchApi.getAiAnswer.mockResolvedValue(answer({ keyPoints: [] }));
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);
    expect(screen.queryByRole('heading', { name: 'Key points' })).not.toBeInTheDocument();
  });
});

// ----------------------------------------------------------------------
describe('when there is no answer', () => {
  it('no search results: says so and does not call the backend', () => {
    renderAnswer({ hasResults: false });
    expect(
      screen.getByText('No reliable sources were found for an AI answer.')
    ).toBeInTheDocument();
    expect(searchApi.getAiAnswer).not.toHaveBeenCalled();
    expect(screen.queryByText('Generating answer…')).not.toBeInTheDocument();
  });

  it('the backend found no sources', async () => {
    searchApi.getAiAnswer.mockResolvedValue(
      answer({ status: 'no_results', generated: false, answer: '', keyPoints: [], sources: [] })
    );
    renderAnswer();
    expect(
      await screen.findByText('No reliable sources were found for an AI answer.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('not enough evidence: shows the message, not an answer', async () => {
    const message =
      "I couldn't find enough reliable information in the available search results to give a confident answer.";
    searchApi.getAiAnswer.mockResolvedValue(
      answer({
        status: 'insufficient_evidence',
        generated: false,
        answer: '',
        keyPoints: [],
        sources: [],
        message
      })
    );
    renderAnswer();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
  });

  it('the model is unavailable: a small note and a way to retry', async () => {
    searchApi.getAiAnswer.mockResolvedValue(
      answer({
        status: 'unavailable',
        reason: 'timeout',
        generated: false,
        answer: '',
        keyPoints: [],
        sources: [],
        message: 'AI answer is temporarily unavailable.'
      })
    );
    renderAnswer();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('AI answer is temporarily unavailable.');
    expect(screen.queryByRole('heading', { name: 'Sources' })).not.toBeInTheDocument();

    searchApi.getAiAnswer.mockResolvedValue(answer());
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText(/open-source search and analytics suite/)).toBeInTheDocument();
    expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(2);
  });

  it('a request that throws is shown as unavailable, not as a crash', async () => {
    searchApi.getAiAnswer.mockRejectedValue(new Error('network down'));
    renderAnswer();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'AI answer is temporarily unavailable.'
    );
  });

  it('not configured: says so quietly', async () => {
    searchApi.getAiAnswer.mockResolvedValue(
      answer({
        status: 'not_configured',
        generated: false,
        answer: '',
        keyPoints: [],
        sources: [],
        message: 'AI answers are not configured on this server.'
      })
    );
    renderAnswer();
    expect(
      await screen.findByText('AI answers are not configured on this server.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
  });

  it('turned off: renders nothing at all', async () => {
    searchApi.getAiAnswer.mockResolvedValue(
      answer({ status: 'disabled', generated: false, answer: '', keyPoints: [], sources: [] })
    );
    const { container } = renderAnswer();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('an empty query renders nothing and asks nothing', () => {
    const { container } = render(<AIAnswer query="" filters={{}} hasResults />);
    expect(container).toBeEmptyDOMElement();
    expect(searchApi.getAiAnswer).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------
describe('controls', () => {
  it('Copy puts the answer, its points and its sources on the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    expect(copied).toContain('OpenSearch is an open-source search and analytics suite [1].');
    expect(copied).toContain('• Distributed full-text search [1]');
    expect(copied).toContain('Sources:');
    expect(copied).toContain('[1] About OpenSearch — https://opensearch.org/docs/about');
    expect(copied).toContain(
      '[2] OpenSearch - Wikipedia — https://en.wikipedia.org/wiki/OpenSearch'
    );
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('says so when copying fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });

  it('Regenerate asks the backend again, bypassing its cache', async () => {
    const user = userEvent.setup();
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);

    searchApi.getAiAnswer.mockResolvedValue(
      answer({ answer: 'A regenerated answer [1].', keyPoints: [] })
    );
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByText(/A regenerated answer/)).toBeInTheDocument();
    expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(2);
    expect(searchApi.getAiAnswer.mock.calls[0][2].refresh).toBe(false);
    expect(searchApi.getAiAnswer.mock.calls[1][2].refresh).toBe(true);
  });

  it('thumbs up sends feedback for this answer and shows it was recorded', async () => {
    const user = userEvent.setup();
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);

    const up = screen.getByRole('button', { name: 'Helpful' });
    const down = screen.getByRole('button', { name: 'Not helpful' });
    expect(up).toHaveAttribute('aria-pressed', 'false');

    await user.click(up);

    expect(searchApi.sendAiFeedback).toHaveBeenCalledWith({
      answerId: '3f2b8c1e-9d4a-4b7e-8a11-5c6d7e8f9a0b',
      query: 'What is OpenSearch?',
      rating: 'up',
      model: 'claude-opus-5-5',
      provider: 'anthropic'
    });
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'true'));
    expect(down).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Thanks for the feedback.')).toBeInTheDocument();

    // Changing your mind sends the new rating.
    await user.click(down);
    expect(searchApi.sendAiFeedback).toHaveBeenLastCalledWith(
      expect.objectContaining({ rating: 'down' })
    );
    await waitFor(() => expect(down).toHaveAttribute('aria-pressed', 'true'));
    expect(up).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not claim feedback was recorded when it was not', async () => {
    const user = userEvent.setup();
    searchApi.sendAiFeedback.mockResolvedValue(false);
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);

    const up = screen.getByRole('button', { name: 'Helpful' });
    await user.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.queryByText('Thanks for the feedback.')).not.toBeInTheDocument();
  });

  it('a long answer starts collapsed and can be expanded and collapsed', async () => {
    const user = userEvent.setup();
    searchApi.getAiAnswer.mockResolvedValue(
      answer({
        answer: `${'OpenSearch stores documents in shards across nodes. '.repeat(12)}[1]`,
        keyPoints: [
          'Point one [1]',
          'Point two [1]',
          'Point three [1]',
          'Point four [2]',
          'Point five [2]'
        ]
      })
    );
    renderAnswer();
    await screen.findByText(/Point one/);

    const toggle = screen.getByRole('button', { name: 'Show more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Point four/)).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText(/Point four/)).toBeInTheDocument();
    expect(screen.getByText(/Point five/)).toBeInTheDocument();
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');

    await user.click(less);
    expect(screen.queryByText(/Point five/)).not.toBeInTheDocument();
  });

  it('a short answer has no expand control', async () => {
    renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);
    expect(screen.queryByRole('button', { name: /Show more|Show less/ })).not.toBeInTheDocument();
  });
});

// ----------------------------------------------------------------------
describe('changing the search', () => {
  it('asks again for a new query, cancels the old request and ignores its late reply', async () => {
    const first = deferred();
    searchApi.getAiAnswer.mockReturnValueOnce(first.promise);
    const { rerender } = renderAnswer();
    const firstSignal = searchApi.getAiAnswer.mock.calls[0][2].signal;

    searchApi.getAiAnswer.mockResolvedValueOnce(
      answer({ query: 'web crawlers', answer: 'A crawler follows links [1].', keyPoints: [] })
    );
    rerender(<AIAnswer query="web crawlers" filters={{}} hasResults />);

    expect(firstSignal.aborted).toBe(true);
    expect(await screen.findByText(/A crawler follows links/)).toBeInTheDocument();
    expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(2);
    expect(searchApi.getAiAnswer.mock.calls[1][0]).toBe('web crawlers');
    // A new question is never a "regenerate".
    expect(searchApi.getAiAnswer.mock.calls[1][2].refresh).toBe(false);

    // The first request finally answers: it must not replace the new one.
    first.resolve(answer({ answer: 'STALE ANSWER [1].', keyPoints: [] }));
    await waitFor(() => expect(screen.queryByText(/STALE ANSWER/)).not.toBeInTheDocument());
    expect(screen.getByText(/A crawler follows links/)).toBeInTheDocument();
  });

  it('a new question after "Regenerate" is asked normally, from the cache if there is one', async () => {
    const user = userEvent.setup();
    const { rerender } = renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(2));

    rerender(<AIAnswer query="web crawlers" filters={{}} hasResults />);
    await waitFor(() => expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(3));
    expect(searchApi.getAiAnswer.mock.calls[2][2].refresh).toBe(false);
  });

  it('asks again when a filter changes', async () => {
    const { rerender } = renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);
    rerender(
      <AIAnswer query="What is OpenSearch?" filters={{ domain: 'opensearch.org' }} hasResults />
    );
    await waitFor(() => expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(2));
    expect(searchApi.getAiAnswer.mock.calls[1][1].domain).toBe('opensearch.org');
  });

  it('stops asking when the results disappear', async () => {
    const { rerender } = renderAnswer();
    await screen.findByText(/open-source search and analytics suite/);
    rerender(<AIAnswer query="What is OpenSearch?" filters={{}} hasResults={false} />);
    expect(
      await screen.findByText('No reliable sources were found for an AI answer.')
    ).toBeInTheDocument();
    expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(1);
  });
});
