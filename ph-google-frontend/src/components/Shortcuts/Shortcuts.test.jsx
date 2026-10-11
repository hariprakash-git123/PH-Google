import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Shortcuts from './Shortcuts';
import BrowserShell, { linkToOpen } from '../BrowserShell/BrowserShell';
import { SHORTCUTS_STORAGE_KEY } from '../../services/shortcuts';
import { checkEmbeddable } from '../../services/embedApi';

/**
 * Homepage shortcuts: a tile per site, opening it like a search result does
 * (in the current PH tab), and a dialog to add, edit and remove them. The
 * list is kept in this browser's localStorage.
 */

vi.mock('../../services/embedApi', () => ({ checkEmbeddable: vi.fn(async () => 'ok') }));

const grid = () => screen.getByRole('region', { name: 'Website shortcuts' });
const names = () =>
  [...document.querySelectorAll('.ph-shortcut-link .ph-shortcut-name')].map(n => n.textContent);
const stored = () => JSON.parse(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) || 'null');
const dialog = () => screen.getByRole('dialog');
const fill = (label, value) =>
  fireEvent.change(within(dialog()).getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
const openAdd = () => fireEvent.click(screen.getByRole('button', { name: 'Add shortcut' }));
const openMenu = name =>
  fireEvent.click(screen.getByRole('button', { name: `Edit or remove ${name}` }));

beforeEach(() => {
  window.localStorage.clear();
  checkEmbeddable.mockResolvedValue('ok');
  window.scrollTo = vi.fn();
});

describe('the shortcut tiles', () => {
  it('start with a small default set and an Add shortcut tile', () => {
    render(<Shortcuts />);
    expect(names()).toEqual(['Wikipedia', 'YouTube', 'GitHub', 'Stack Overflow', 'Add shortcut']);
    expect(within(grid()).getByRole('button', { name: 'Add shortcut' })).toBeInTheDocument();
  });

  it('each shows its site’s own icon, from the site, and falls back to its first letter', () => {
    render(<Shortcuts />);
    const link = screen.getByRole('link', { name: 'GitHub' });
    const icon = link.querySelector('img');
    expect(icon).toHaveAttribute('src', 'https://github.com/favicon.ico');
    expect(icon).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(icon);
    expect(link.querySelector('img')).toBeNull();
    expect(link.querySelector('.ph-shortcut-letter')).toHaveTextContent('G');
  });

  it('a shortcut is a link that opens in the current PH tab; Ctrl/middle-click are the browser’s', () => {
    render(<Shortcuts />);
    const link = screen.getByRole('link', { name: 'Wikipedia' });
    expect(link).toHaveAttribute('href', 'https://www.wikipedia.org/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('data-ph-result');
    expect(linkToOpen({ defaultPrevented: false, button: 0, target: link })).toMatchObject({
      url: 'https://www.wikipedia.org/',
      inPlace: true
    });
    expect(
      linkToOpen({ defaultPrevented: false, button: 0, ctrlKey: true, target: link })
    ).toBeNull();
    expect(linkToOpen({ defaultPrevented: false, button: 1, target: link })).toBeNull();
  });

  it('inside PH Spectrum, a click opens the site in the same tab — no new PH tab, no browser tab', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserShell>
          <Routes>
            <Route path="*" element={<Shortcuts />} />
          </Routes>
        </BrowserShell>
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: 'GitHub' });
    expect(fireEvent.click(link, { button: 0 })).toBe(false); // the browser's new tab was stopped
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    const frame = await screen.findByTitle('GitHub');
    expect(frame).toHaveAttribute('src', 'https://github.com/');
    expect(opened).not.toHaveBeenCalled();
    // Back returns the tab to the homepage.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('link', { name: 'GitHub' })).toBeVisible();
    opened.mockRestore();
  });
});

describe('adding a shortcut', () => {
  it('saves a new tile after the others, and keeps it after a reload', () => {
    const { unmount } = render(<Shortcuts />);
    openAdd();
    expect(dialog()).toHaveAccessibleName('Add shortcut');
    fill('Name', 'Example');
    fill('URL', 'example.com/docs');
    save();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Example' })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    );
    expect(stored().version).toBe(1);
    expect(stored().items.map(i => i.name)).toEqual([
      'Wikipedia',
      'YouTube',
      'GitHub',
      'Stack Overflow',
      'Example'
    ]);
    unmount();
    render(<Shortcuts />);
    expect(screen.getByRole('link', { name: 'Example' })).toBeInTheDocument();
  });

  it('with no name, the shortcut is named after its site', () => {
    render(<Shortcuts />);
    openAdd();
    fill('URL', 'https://www.bbc.co.uk/news');
    save();
    expect(screen.getByRole('link', { name: 'bbc.co.uk' })).toBeInTheDocument();
  });

  it.each([
    ['javascript:alert(1)', /Only web addresses/],
    ['data:text/html,<b>x</b>', /Only web addresses/],
    ['not a url', /no spaces/]
  ])('refuses %s, says why, and stays open', (url, message) => {
    render(<Shortcuts />);
    openAdd();
    fill('URL', url);
    save();
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(message);
    expect(within(dialog()).getByLabelText('URL')).toHaveAttribute('aria-invalid', 'true');
    expect(document.body.innerHTML).not.toMatch(/href="javascript:|href="data:/);
    expect(stored()).toBeNull();
  });

  it('refuses a second shortcut for the same site, however its address is written', () => {
    render(<Shortcuts />);
    openAdd();
    fill('Name', 'Another YouTube');
    fill('URL', 'http://youtube.com');
    save();
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(
      'You already have a shortcut for this site: YouTube.'
    );
    expect(names().filter(n => /YouTube/.test(n))).toEqual(['YouTube']);
  });

  it('Cancel and Escape close without saving, and focus goes back to Add shortcut', async () => {
    render(<Shortcuts />);
    openAdd();
    fill('URL', 'example.com');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openAdd();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(stored()).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add shortcut' }))
    );
  });

  it('Save waits for an address', () => {
    render(<Shortcuts />);
    openAdd();
    expect(within(dialog()).getByRole('button', { name: 'Save' })).toBeDisabled();
    // Focus starts in the dialog.
    expect(document.activeElement).toBe(within(dialog()).getByLabelText('Name'));
  });

  it('the Add tile goes once the list is full', () => {
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        items: Array.from({ length: 10 }, (_, i) => ({
          id: `s${i}`,
          name: `Site ${i}`,
          url: `https://site${i}.example/`
        }))
      })
    );
    render(<Shortcuts />);
    expect(screen.queryByRole('button', { name: 'Add shortcut' })).not.toBeInTheDocument();
  });
});

describe('editing and removing', () => {
  it('Edit changes the name and address in place, and keeps it after a reload', () => {
    const { unmount } = render(<Shortcuts />);
    openMenu('GitHub');
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit shortcut/ }));
    expect(dialog()).toHaveAccessibleName('Edit shortcut');
    expect(within(dialog()).getByLabelText('Name')).toHaveValue('GitHub');
    expect(within(dialog()).getByLabelText('URL')).toHaveValue('https://github.com/');
    fill('Name', 'My repos');
    fill('URL', 'https://github.com/nodejs');
    save();
    expect(names()).toEqual(['Wikipedia', 'YouTube', 'My repos', 'Stack Overflow', 'Add shortcut']);
    unmount();
    render(<Shortcuts />);
    expect(screen.getByRole('link', { name: 'My repos' })).toHaveAttribute(
      'href',
      'https://github.com/nodejs'
    );
  });

  it('a shortcut can be saved again under its own address, but not moved onto another’s', () => {
    render(<Shortcuts />);
    openMenu('GitHub');
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit shortcut/ }));
    fill('URL', 'https://www.youtube.com');
    save();
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(/already have a shortcut/);
    fill('URL', 'http://github.com');
    save();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Remove takes the tile away, and it stays gone after a reload', () => {
    const { unmount } = render(<Shortcuts />);
    openMenu('YouTube');
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove/ }));
    expect(screen.queryByRole('link', { name: 'YouTube' })).not.toBeInTheDocument();
    unmount();
    render(<Shortcuts />);
    expect(names()).toEqual(['Wikipedia', 'GitHub', 'Stack Overflow', 'Add shortcut']);
  });

  it('the menu is a real button with a name; Escape closes it', () => {
    render(<Shortcuts />);
    const button = screen.getByRole('button', { name: 'Edit or remove Wikipedia' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(button);
  });

  it('when the browser will not store them, the change still shows and says it will not last', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<Shortcuts />);
    openMenu('YouTube');
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove/ }));
    expect(screen.queryByRole('link', { name: 'YouTube' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/could not be saved in this browser/);
    vi.restoreAllMocks();
  });
});
