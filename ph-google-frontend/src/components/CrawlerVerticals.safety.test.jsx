import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NewsResults from './NewsResults/NewsResults';
import VideoResults from './VideoResults/VideoResults';
import ImageResults from './ImageResults/ImageResults';
import MapResults from './MapResults/MapResults';
import { safeEmbedUrl } from '../utils/safeUrl';

/**
 * The crawler-backed News, Video, Image and Map views render addresses taken
 * from crawled pages. None of them may become a link, an image source or a
 * frame unless it is plain http(s) — and frames only from the hosts the
 * backend builds embeds for, sandboxed. Nothing tells the public to crawl.
 */

const UNSAFE = ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '/relative/path'];
const bodyHtml = () => document.body.innerHTML;

describe('safeEmbedUrl', () => {
  it.each([
    ['https://www.youtube-nocookie.com/embed/abc', true],
    ['https://player.vimeo.com/video/1', true],
    ['http://player.vimeo.com/video/1', false], // https only
    ['https://evil.example/embed', false],
    ['https://player.vimeo.com.evil.example/video/1', false],
    ['https://user:pass@player.vimeo.com/video/1', false],
    ['javascript:alert(1)', false]
  ])('%s → %s', (url, ok) => {
    const hosts = ['www.youtube-nocookie.com', 'player.vimeo.com'];
    expect(Boolean(safeEmbedUrl(url, hosts))).toBe(ok);
  });
});

describe('News', () => {
  it.each(UNSAFE)(
    'an article at %s is shown as text, never linked; its image is not loaded',
    url => {
      render(
        <NewsResults
          query="q"
          results={[
            { id: 'a', url, imageUrl: 'javascript:alert(2)', title: 'An article', source: 'site' }
          ]}
        />
      );
      expect(screen.getByText('An article')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(document.querySelector('img')).toBeNull();
      expect(bodyHtml()).not.toMatch(/javascript:|data:text|vbscript:/);
    }
  );

  it('a normal article is linked as before', () => {
    render(
      <NewsResults
        query="q"
        results={[
          {
            id: 'a',
            url: 'https://news.example/a',
            imageUrl: 'https://news.example/a.jpg',
            title: 'An article',
            source: 'news.example'
          }
        ]}
      />
    );
    expect(screen.getByRole('link', { name: 'An article' })).toHaveAttribute(
      'href',
      'https://news.example/a'
    );
    expect(document.querySelector('img')).toHaveAttribute('src', 'https://news.example/a.jpg');
  });

  it('the empty state does not tell the public to crawl from the admin console', () => {
    render(<NewsResults query="q" results={[]} />);
    expect(screen.queryByText(/admin console|crawl/i)).not.toBeInTheDocument();
  });
});

describe('Videos', () => {
  const video = overrides => ({
    id: 'v',
    title: 'A video',
    provider: 'youtube',
    source: 'site',
    url: 'https://site.example/v',
    sourcePage: 'https://site.example/page',
    thumbnailUrl: 'https://site.example/t.jpg',
    embedUrl: 'https://www.youtube-nocookie.com/embed/abc',
    ...overrides
  });
  const play = () => fireEvent.click(screen.getByRole('button', { name: /Play/ }));

  it('a known player is framed over https, sandboxed, with only what a player needs', () => {
    render(<VideoResults query="q" results={[video()]} />);
    play();
    const frame = document.querySelector('iframe');
    expect(frame).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abc');
    const sandbox = frame.getAttribute('sandbox').split(' ');
    expect(sandbox).toEqual(
      expect.arrayContaining(['allow-scripts', 'allow-same-origin', 'allow-presentation'])
    );
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-forms');
  });

  it.each([
    'https://evil.example/embed/abc',
    'javascript:alert(1)',
    'http://www.youtube-nocookie.com/embed/abc'
  ])('an embed address %s is not framed', embedUrl => {
    render(<VideoResults query="q" results={[video({ embedUrl })]} />);
    play();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/cannot be played here/)).toBeInTheDocument();
  });

  it('unsafe page, file and thumbnail addresses are not linked or loaded', () => {
    render(
      <VideoResults
        query="q"
        results={[
          video({
            sourcePage: 'javascript:alert(1)',
            url: 'javascript:alert(2)',
            thumbnailUrl: 'javascript:alert(3)',
            embedUrl: ''
          })
        ]}
      />
    );
    expect(document.querySelector('img')).toBeNull();
    play();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(document.querySelector('video')).toBeNull();
    expect(bodyHtml()).not.toMatch(/javascript:/);
  });
});

describe('Images', () => {
  it('an image whose address is not http(s) is not shown at all', () => {
    render(
      <ImageResults
        query="q"
        results={[
          { id: '1', url: 'javascript:alert(1)', title: 'Bad', source: 's' },
          { id: '2', url: 'https://img.example/2.jpg', title: 'Good', source: 's' }
        ]}
      />
    );
    const images = [...document.querySelectorAll('img')];
    expect(images.map(img => img.getAttribute('src'))).toEqual(['https://img.example/2.jpg']);
  });

  it('the lightbox links only to a safe source page', () => {
    render(
      <ImageResults
        query="q"
        results={[
          {
            id: '2',
            url: 'https://img.example/2.jpg',
            sourcePage: 'javascript:alert(1)',
            title: 'Good',
            source: 's'
          }
        ]}
      />
    );
    fireEvent.click(screen.getByTitle('Good'));
    expect(screen.queryByRole('link', { name: /Visit page/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open image/ })).toHaveAttribute(
      'href',
      'https://img.example/2.jpg'
    );
  });

  it('the empty state does not tell the public to crawl from the admin console', () => {
    render(<ImageResults query="q" results={[]} />);
    expect(screen.queryByText(/admin console|crawl/i)).not.toBeInTheDocument();
  });
});

describe('Maps', () => {
  const place = overrides => ({
    id: 'p',
    name: 'A place',
    latitude: 13.08,
    longitude: 80.27,
    domain: 'site.example',
    embedUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=1%2C2%2C3%2C4',
    mapUrl: 'https://www.openstreetmap.org/?mlat=13.08&mlon=80.27',
    sourcePage: 'https://site.example/place',
    ...overrides
  });

  it('the OpenStreetMap embed is framed, sandboxed', () => {
    render(<MapResults query="q" results={[place()]} />);
    const frame = document.querySelector('iframe');
    expect(frame.getAttribute('src')).toMatch(/^https:\/\/www\.openstreetmap\.org\//);
    const sandbox = frame.getAttribute('sandbox').split(' ');
    expect(sandbox).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin']));
    expect(sandbox).not.toContain('allow-top-navigation');
  });

  it('any other embed address is not framed, and unsafe links are not linked', () => {
    render(
      <MapResults
        query="q"
        results={[
          place({
            embedUrl: 'https://evil.example/map',
            mapUrl: 'javascript:alert(1)',
            sourcePage: 'data:text/html,x'
          })
        ]}
      />
    );
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/map for this place cannot be shown/)).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
