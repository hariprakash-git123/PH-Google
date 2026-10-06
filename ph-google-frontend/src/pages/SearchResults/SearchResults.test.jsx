import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SearchResults from './SearchResults';
import { searchApi } from '../../services/searchApi';

/**
 * The results page with the AI answer in place.
 *
 * What matters here is the relationship between the two: the answer sits
 * above the web results, never replaces them, and no outcome of the answer —
 * slow, failed, absent — changes whether the results are shown.
 *
 * The page chrome (header, tabs, filters) is replaced with stubs; the page
 * itself, the result cards and the AI answer component are real.
 */

vi.mock('../../services/searchApi', () => ({
  searchApi: {
    search: vi.fn(),
    getAiAnswer: vi.fn(),
    sendAiFeedback: vi.fn()
  }
}));
vi.mock('../../components/Header/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('../../components/SearchTabs/SearchTabs', () => ({
  default: () => <div data-testid="tabs" />
}));
vi.mock('../../components/Filters/Filters', () => ({
  default: () => <div data-testid="filters" />
}));

const RESULTS = [
  {
    id: 'r1',
    url: 'https://opensearch.org/docs/about',
    displayUrl: 'opensearch.org › docs › about',
    domain: 'opensearch.org',
    title: 'About OpenSearch',
    snippet: 'OpenSearch is an open-source search and analytics suite.',
    publishedAgo: '2 hours ago',
    score: 12.5
  },
  {
    id: 'r2',
    url: 'https://en.wikipedia.org/wiki/OpenSearch',
    displayUrl: 'en.wikipedia.org › wiki › OpenSearch',
    domain: 'en.wikipedia.org',
    title: 'OpenSearch - Wikipedia',
    snippet: 'OpenSearch is a family of software.',
    publishedAgo: '1 day ago',
    score: 9.1
  }
];

const searchResponse = (overrides = {}) => ({
  query: 'What is OpenSearch?',
  results: RESULTS,
  total: 2,
  latency: '0.012s',
  pagination: {
    page: 1,
    limit: 10,
    totalResults: 2,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false
  },
  ...overrides
});

const aiAnswer = (overrides = {}) => ({
  answerId: '3f2b8c1e-9d4a-4b7e-8a11-5c6d7e8f9a0b',
  query: 'What is OpenSearch?',
  status: 'ok',
  generated: true,
  answer: 'OpenSearch is an open-source search and analytics suite [1].',
  keyPoints: ['Distributed full-text search [1]'],
  sources: [
    {
      index: 1,
      title: 'About OpenSearch',
      url: 'https://opensearch.org/docs/about',
      domain: 'opensearch.org',
      snippet: '',
      relevanceScore: 12.5
    }
  ],
  message: null,
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  ...overrides
});

const renderPage = (url = '/search?q=What+is+OpenSearch%3F') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SearchResults />
    </MemoryRouter>
  );

function deferred() {
  let resolve;
  const promise = new Promise(res => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  searchApi.search.mockReset();
  searchApi.getAiAnswer.mockReset();
  searchApi.sendAiFeedback.mockReset();
  searchApi.search.mockResolvedValue(searchResponse());
  searchApi.getAiAnswer.mockResolvedValue(aiAnswer());
});

describe('search results page with the AI answer', () => {
  it('shows the AI answer above the normal results, and both are present', async () => {
    renderPage();

    const answerCard = await screen.findByRole('region', { name: 'AI answer' });
    expect(
      await screen.findByText(/OpenSearch is an open-source search and analytics suite\s*$/)
    ).toBeDefined();
    const firstResult = screen.getByRole('heading', { name: 'About OpenSearch' });
    const secondResult = screen.getByRole('heading', { name: 'OpenSearch - Wikipedia' });

    expect(firstResult).toBeInTheDocument();
    expect(secondResult).toBeInTheDocument();
    // DOM order: the answer comes before the first result.
    expect(
      answerCard.compareDocumentPosition(firstResult) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // The old placeholder is gone.
    expect(screen.queryByText(/PH AI Preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/future RAG search layer/i)).not.toBeInTheDocument();
  });

  it('sends the query to the search API and to the AI answer API', async () => {
    renderPage('/search?q=What+is+OpenSearch%3F');
    await screen.findByRole('region', { name: 'AI answer' });

    expect(searchApi.search).toHaveBeenCalledWith(
      'What is OpenSearch?',
      'all',
      expect.objectContaining({ page: 1 })
    );
    await waitFor(() => expect(searchApi.getAiAnswer).toHaveBeenCalledTimes(1));
    expect(searchApi.getAiAnswer.mock.calls[0][0]).toBe('What is OpenSearch?');
  });

  it('results are on screen while the answer is still being generated', async () => {
    const pending = deferred();
    searchApi.getAiAnswer.mockReturnValue(pending.promise);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'About OpenSearch' })).toBeInTheDocument();
    expect(screen.getByText('Generating answer…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'OpenSearch - Wikipedia' })).toBeInTheDocument();

    pending.resolve(aiAnswer());
    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'About OpenSearch' })).toBeInTheDocument();
  });

  it.each([
    ['unavailable', 'AI answer is temporarily unavailable.'],
    [
      'insufficient_evidence',
      "I couldn't find enough reliable information in the available search results to give a confident answer."
    ],
    ['not_configured', 'AI answers are not configured on this server.']
  ])(
    'AI status "%s": the note is shown and every result still renders',
    async (status, message) => {
      searchApi.getAiAnswer.mockResolvedValue(
        aiAnswer({ status, generated: false, answer: '', keyPoints: [], sources: [], message })
      );
      renderPage();

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'About OpenSearch' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'OpenSearch - Wikipedia' })).toBeInTheDocument();
    }
  );

  it('the AI request throwing does not break the page', async () => {
    searchApi.getAiAnswer.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'AI answer is temporarily unavailable.'
    );
    expect(screen.getByRole('heading', { name: 'About OpenSearch' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'OpenSearch - Wikipedia' })).toBeInTheDocument();
  });

  it('no results: the AI note and the normal no-results state, and no AI request', async () => {
    searchApi.search.mockResolvedValue(
      searchResponse({
        results: [],
        total: 0,
        pagination: { page: 1, limit: 10, totalResults: 0, totalPages: 0 }
      })
    );
    renderPage('/search?q=xylophone+zeppelin');

    expect(
      await screen.findByText('No reliable sources were found for an AI answer.')
    ).toBeInTheDocument();
    expect(screen.getByText(/No results found for/)).toBeInTheDocument();
    expect(searchApi.getAiAnswer).not.toHaveBeenCalled();
  });

  it('page 2 shows results without an AI answer', async () => {
    searchApi.search.mockResolvedValue(
      searchResponse({
        pagination: { page: 2, limit: 10, totalResults: 12, totalPages: 2, hasPreviousPage: true }
      })
    );
    renderPage('/search?q=opensearch&page=2');

    expect(await screen.findByRole('heading', { name: 'About OpenSearch' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'AI answer' })).not.toBeInTheDocument();
    expect(searchApi.getAiAnswer).not.toHaveBeenCalled();
  });

  it('a search failure shows the search error and no AI answer', async () => {
    searchApi.search.mockResolvedValue(
      searchResponse({ results: [], total: 0, error: 'Search is down.' })
    );
    renderPage();

    expect(await screen.findByText('Search is unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'AI answer' })).not.toBeInTheDocument();
    expect(searchApi.getAiAnswer).not.toHaveBeenCalled();
  });

  it('no query: no search and no AI answer', async () => {
    renderPage('/search');
    expect(await screen.findByText('Enter a search query')).toBeInTheDocument();
    expect(searchApi.search).not.toHaveBeenCalled();
    expect(searchApi.getAiAnswer).not.toHaveBeenCalled();
  });
});
