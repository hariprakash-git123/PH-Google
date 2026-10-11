import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Login from './Login';

/** The sign-in page: fields, show/hide password, validation, errors, links. */

const auth = vi.hoisted(() => ({
  isAuthenticated: false,
  login: vi.fn()
}));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../components/Header/Header', () => ({ default: () => <div data-testid="header" /> }));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}
const renderLogin = (entry = '/login') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
const email = () => screen.getByLabelText('Email address');
const password = () => screen.getByLabelText('Password');
const submit = () => fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));

beforeEach(() => {
  auth.isAuthenticated = false;
  auth.login.mockReset();
});

describe('the sign-in form', () => {
  it('has the email and password fields, the sign-in button and both links', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: 'Sign in to PH Spectrum' })).toBeInTheDocument();
    expect(email()).toHaveAttribute('type', 'email');
    expect(password()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/signup');
  });

  it('shows and hides the password', () => {
    renderLogin();
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(password()).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password()).toHaveAttribute('type', 'password');
    expect(auth.login).not.toHaveBeenCalled(); // the toggle never submits
  });

  it('checks the fields before asking the server', () => {
    renderLogin();
    submit();
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    fireEvent.change(email(), { target: { value: 'not-an-email' } });
    submit();
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(email()).toHaveAttribute('aria-invalid', 'true');
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('signs in and returns to the home page', async () => {
    let finish;
    auth.login.mockImplementation(() => new Promise(resolve => (finish = resolve)));
    renderLogin();
    fireEvent.change(email(), { target: { value: ' reader@example.com ' } });
    fireEvent.change(password(), { target: { value: 'secret-pass' } });
    submit();
    expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    finish({});
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/'));
    expect(auth.login).toHaveBeenCalledWith('reader@example.com', 'secret-pass');
  });

  it('shows the server’s error and stays on the page', async () => {
    auth.login.mockRejectedValue(new Error('Invalid email or password.'));
    renderLogin();
    fireEvent.change(email(), { target: { value: 'reader@example.com' } });
    fireEvent.change(password(), { target: { value: 'wrong' } });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeEnabled();
  });

  it('after a password reset: a confirmation, and the email filled in', () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: {
              email: 'reader@example.com',
              notice: 'Password reset. Sign in with your new password.'
            }
          }
        ]}
      >
        <Routes>
          <Route path="/login" element={<Login />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Password reset. Sign in with your new password.'
    );
    expect(email()).toHaveValue('reader@example.com');
  });

  it('an already signed-in user is told so', () => {
    auth.isAuthenticated = true;
    renderLogin();
    expect(screen.getByText("You're already signed in!")).toBeInTheDocument();
  });
});
