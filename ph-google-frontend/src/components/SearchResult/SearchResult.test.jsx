import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import SearchResult from './SearchResult';
import { faviconUrlFor } from '../../utils/favicon';

/**
 * Each web result shows the icon of the site it links to — fetched from that
 * site's own origin — and the generic icon only when there is no safe site
 * to ask, or the site's icon fails to load. The rest of the card is as it was.
 */

/** A web result as the index (OpenSearch) returns it. */
const indexResult = (overrides = {}) => ({
  id: 'abc123',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  displayUrl: 'youtube.com › watch',
  domain: 'youtube.com',
  favicon: '🌐',
  title: 'A video on YouTube',
  snippet: 'Watch it on YouTube.',
  publishedAgo: '2 days ago',
  category: 'Web Result',
  saved: false,
  score: 3.2,
  source: 'index',
  ...overrides
});

/** A web result as an external provider (SerpApi, Parallel, Bing) returns it. */
const externalResult = (overrides = {}) => ({
  id: 'serpapi:9f8e',
  url: 'https://github.com/nodejs/node',
  displayUrl: 'github.com › nodejs › node',
  domain: 'github.com',
  favicon: '🌐',
  title: 'nodejs/node',
  snippet: 'Node.js JavaScript runtime.',
  publishedAgo: 'Unknown',
  category: 'Web',
  score: null,
  source: 'serpapi',
  sourceRank: 1,
  ...overrides
});

const icon = () => screen.getByRole('img', { name: 'site icon' });
const siteIcon = () => icon().querySelector('img');

describe('faviconUrlFor', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/favicon.ico'],
    ['https://github.com/nodejs/node', 'https://github.com/favicon.ico'],
    ['https://en.wikipedia.org/wiki/Mathematics', 'https://en.wikipedia.org/favicon.ico'],
    ['https://stackoverflow.com/questions/1/x', 'https://stackoverflow.com/favicon.ico'],
    ['http://example.org/a?b=c#d', 'http://example.org/favicon.ico'],
    ['  https://Example.COM/path  ', 'https://example.com/favicon.ico'],
    ['https://example.org:8443/a', 'https://example.org:8443/favicon.ico']
  ])('%s → %s', (pageUrl, expected) => {
    expect(faviconUrlFor(pageUrl)).toBe(expected);
  });

  it('gives different sites different icons, and one site the same icon for every page', () => {
    const icons = [
      'https://www.youtube.com/watch?v=1',
      'https://github.com/a/b',
      'https://en.wikipedia.org/wiki/X',
      'https://stackoverflow.com/q/1'
    ].map(faviconUrlFor);
    expect(new Set(icons).size).toBe(4);
    expect(faviconUrlFor('https://github.com/x')).toBe(faviconUrlFor('https://github.com/y/z'));
  });

  it.each([
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<b>x</b>'],
    ['a file: URL', 'file:///etc/passwd'],
    ['an ftp: URL', 'ftp://files.example.org/a'],
    ['a relative path', '/wiki/Mathematics'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['not a URL', 'not a url at all'],
    ['an empty string', ''],
    ['credentials in the URL', 'https://user:pass@example.org/'],
    ['localhost', 'http://localhost:5000/api'],
    ['a bare local name', 'http://router/admin'],
    ['a .local name', 'http://printer.local/'],
    ['an IPv4 address', 'http://192.168.1.1/'],
    ['an IPv6 address', 'http://[::1]/'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined]
  ])('%s gives no icon address', (_label, value) => {
    expect(faviconUrlFor(value)).toBeNull();
  });
});

describe('the icon on a result card', () => {
  it('a YouTube result shows YouTube’s own icon, from YouTube', () => {
    render(<SearchResult result={indexResult()} />);
    expect(siteIcon()).toHaveAttribute('src', 'https://www.youtube.com/favicon.ico');
    // Decorative: the label is on the wrapper, and no page address is leaked to the site.
    expect(siteIcon()).toHaveAttribute('alt', '');
    expect(siteIcon()).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(siteIcon()).toHaveAttribute('loading', 'lazy');
    expect(siteIcon()).toHaveAttribute('width', '16');
    expect(siteIcon()).toHaveAttribute('height', '16');
    expect(icon()).not.toHaveTextContent('🌐');
  });

  it('results from different sites show different icons', () => {
    render(
      <>
        <SearchResult result={indexResult()} />
        <SearchResult result={externalResult()} />
        <SearchResult
          result={indexResult({ id: 'w', url: 'https://en.wikipedia.org/wiki/Mathematics' })}
        />
        <SearchResult
          result={externalResult({ id: 's', url: 'https://stackoverflow.com/questions/1' })}
        />
      </>
    );
    const srcs = screen
      .getAllByRole('img', { name: 'site icon' })
      .map(wrapper => wrapper.querySelector('img').getAttribute('src'));
    expect(srcs).toEqual([
      'https://www.youtube.com/favicon.ico',
      'https://github.com/favicon.ico',
      'https://en.wikipedia.org/favicon.ico',
      'https://stackoverflow.com/favicon.ico'
    ]);
  });

  it('when the site’s icon fails to load, the generic icon is shown — once, with no retry loop', () => {
    render(<SearchResult result={indexResult()} />);
    fireEvent.error(siteIcon());
    expect(siteIcon()).toBeNull();
    expect(icon()).toHaveTextContent('🌐');
    // Nothing is left that could fail again.
    expect(icon().querySelectorAll('img')).toHaveLength(0);
  });

  it('after a failure, a card shown for another site tries that site’s icon', () => {
    const { rerender } = render(<SearchResult result={indexResult()} />);
    fireEvent.error(siteIcon());
    expect(siteIcon()).toBeNull();
    rerender(<SearchResult result={indexResult({ url: 'https://github.com/a/b' })} />);
    expect(siteIcon()).toHaveAttribute('src', 'https://github.com/favicon.ico');
  });

  it.each([
    ['no URL at all', { url: undefined }],
    ['an empty URL', { url: '' }],
    ['an unsafe URL', { url: 'javascript:alert(1)' }],
    ['a relative URL', { url: '/wiki/Mathematics' }],
    ['a local address', { url: 'http://localhost:8080/' }]
  ])('%s: the generic icon, and no image request', (_label, overrides) => {
    render(<SearchResult result={indexResult(overrides)} />);
    expect(siteIcon()).toBeNull();
    expect(icon()).toHaveTextContent('🌐');
  });

  it.each([
    ['no favicon field', { favicon: undefined }],
    ['an empty favicon field', { favicon: '' }],
    ['a favicon field that is an address, not an icon', { favicon: 'https://evil.example/x.png' }]
  ])('%s: the site icon still shows, and the fallback is the generic icon', (_label, overrides) => {
    render(<SearchResult result={indexResult(overrides)} />);
    expect(siteIcon()).toHaveAttribute('src', 'https://www.youtube.com/favicon.ico');
    fireEvent.error(siteIcon());
    expect(icon()).toHaveTextContent('🌐');
    expect(icon()).not.toHaveTextContent('evil');
  });

  it('a text icon the backend sends is the fallback', () => {
    render(<SearchResult result={indexResult({ favicon: '📰', url: 'not a url' })} />);
    expect(icon()).toHaveTextContent('📰');
  });
});

describe('the rest of the card is unchanged', () => {
  it.each([
    ['an index result', indexResult()],
    ['an external result', externalResult()]
  ])('%s keeps its domain, date, badge, title link, URL, snippet and actions', (_label, result) => {
    const { container } = render(<SearchResult result={result} />);
    const card = container.querySelector('article.ph-search-result-card');
    expect(card).not.toBeNull();
    const header = card.querySelector('.ph-result-meta-header');
    // Icon first, then the domain block, then the badge — as before.
    expect([...header.children].map(child => child.className)).toEqual([
      'ph-result-favicon',
      'ph-result-domain-wrap',
      'ph-result-category-badge'
    ]);
    expect(within(header).getByText(result.domain)).toBeInTheDocument();
    expect(within(header).getByText(result.publishedAgo)).toBeInTheDocument();
    expect(within(header).getByText(result.category)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: result.title })).toHaveAttribute('href', result.url);
    expect(card.querySelector('.ph-result-url')).toHaveTextContent(result.url);
    expect(screen.getByText(result.snippet)).toBeInTheDocument();
    // Save stored nothing, so it was removed; Share stays.
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share URL' })).toBeInTheDocument();
  });

  it('the title link opens a new tab outside PH Spectrum, and is marked for it as a result', () => {
    render(<SearchResult result={externalResult()} />);
    const link = screen.getByRole('link', { name: 'nodejs/node' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // The shell opens a marked link in the PH tab it was clicked in.
    expect(link).toHaveAttribute('data-ph-result');
  });

  it('an unsafe result URL is still not linked', () => {
    render(<SearchResult result={externalResult({ url: 'javascript:alert(1)' })} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'nodejs/node' })).toBeInTheDocument();
  });
});
