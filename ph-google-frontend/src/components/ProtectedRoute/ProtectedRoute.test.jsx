import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../../context/AuthContext';
import ProtectedRoute from './ProtectedRoute';
import Header from '../Header/Header';
import { authApi } from '../../services/authApi';

/**
 * Who may open /admin, and who sees the link to it.
 *
 * The real AuthProvider, guard and header are used; only the profile request
 * is stubbed. The stored user in localStorage stands for what a browser holds,
 * which anyone can edit — so it must never be enough on its own.
 */

vi.mock('../../services/authApi', () => ({
  authApi: { getProfile: vi.fn(), login: vi.fn(), register: vi.fn() }
}));
vi.mock('../SearchBar/SearchBar', () => ({ default: () => <div data-testid="searchbar" /> }));

const ADMIN = { id: 'a1', name: 'Ada', email: 'ada@example.com', role: 'admin' };
const USER = { id: 'u1', name: 'Bob', email: 'bob@example.com', role: 'user' };

function storeSession(user) {
  localStorage.setItem('ph_token', 'stored-token');
  localStorage.setItem('ph_user', JSON.stringify(user));
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Header />} />
          <Route path="/login" element={<p>Login page</p>} />
          <Route
            path="/admin"
            element={
              <ProtectedRoute adminOnly>
                <p>Admin console</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('ProtectedRoute adminOnly', () => {
  it('sends a guest to the login page', async () => {
    renderAt('/admin');
    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(screen.queryByText('Admin console')).not.toBeInTheDocument();
  });

  it('shows access denied to a signed-in normal user', async () => {
    storeSession(USER);
    authApi.getProfile.mockResolvedValue({ user: USER });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('Admin console')).not.toBeInTheDocument();
  });

  it('ignores an admin role edited into localStorage when the server says user', async () => {
    storeSession({ ...USER, role: 'admin' });
    authApi.getProfile.mockResolvedValue({ user: USER });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('Admin console')).not.toBeInTheDocument();
  });

  it('does not trust a stored admin role when the server cannot be reached', async () => {
    storeSession(ADMIN);
    authApi.getProfile.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    renderAt('/admin');
    expect(
      await screen.findByRole('heading', { name: 'Could not confirm your access' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Admin console')).not.toBeInTheDocument();
  });

  it('opens for an admin the server has confirmed', async () => {
    storeSession(ADMIN);
    authApi.getProfile.mockResolvedValue({ user: ADMIN });
    renderAt('/admin');
    expect(await screen.findByText('Admin console')).toBeInTheDocument();
  });
});

describe('Header', () => {
  const openApps = () => fireEvent.click(screen.getByRole('button', { name: 'PH apps' }));

  it('has no About or How it works entries', async () => {
    renderAt('/');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument());
    expect(screen.queryByText(/^About$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/How it works/i)).not.toBeInTheDocument();
  });

  it('hides the admin link from a normal user', async () => {
    storeSession(USER);
    authApi.getProfile.mockResolvedValue({ user: USER });
    renderAt('/');
    await screen.findByRole('button', { name: /Account menu for Bob/ });
    openApps();
    expect(screen.getByText('PH Ecosystem')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Admin Ops/ })).not.toBeInTheDocument();
  });

  it('shows the admin link to a confirmed admin', async () => {
    storeSession(ADMIN);
    authApi.getProfile.mockResolvedValue({ user: ADMIN });
    renderAt('/');
    await waitFor(() => expect(authApi.getProfile).toHaveBeenCalled());
    openApps();
    expect(await screen.findByRole('link', { name: /Admin Ops/ })).toHaveAttribute(
      'href',
      '/admin'
    );
  });

  it('closes the apps menu on Escape and reports its state', async () => {
    renderAt('/');
    const button = await screen.findByRole('button', { name: 'PH apps' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('PH Ecosystem')).not.toBeInTheDocument();
  });
});
