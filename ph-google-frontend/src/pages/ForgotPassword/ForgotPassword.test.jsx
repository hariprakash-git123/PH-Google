import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ForgotPassword from './ForgotPassword';
import { authApi } from '../../services/authApi';

/**
 * Forgot password, step by step: email → code → new password → done. The
 * API is a stand-in; no email is sent. Rules are the server's — this checks
 * the page shows its answers and never keeps or prints the reset token.
 */

vi.mock('../../services/authApi', () => ({
  authApi: {
    forgotPassword: vi.fn(),
    verifyResetCode: vi.fn(),
    resetPassword: vi.fn()
  }
}));
vi.mock('../../components/Header/Header', () => ({ default: () => <div data-testid="header" /> }));

const SENT =
  'If an account exists for that email address, we have sent it a 6-digit code. The code expires in 10 minutes.';
const TOKEN = 'reset-token-only-in-memory-abcdefghijklmnopqrstuvwxyz';

const renderPage = (state = undefined) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/forgot-password', state }]}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>
  );
const type = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = name => fireEvent.click(screen.getByRole('button', { name }));

async function toCodeStep() {
  renderPage();
  type('Email address', 'reader@example.com');
  click(/Send code/);
  await screen.findByRole('heading', { name: 'Check your email' });
}
async function toPasswordStep() {
  await toCodeStep();
  type('6-digit code', '123456');
  click(/Verify code/);
  await screen.findByRole('heading', { name: 'Choose a new password' });
}

beforeEach(() => {
  authApi.forgotPassword.mockReset().mockResolvedValue({ message: SENT });
  authApi.verifyResetCode
    .mockReset()
    .mockResolvedValue({ resetToken: TOKEN, expiresInSeconds: 900 });
  authApi.resetPassword.mockReset().mockResolvedValue({
    message: 'Your password has been reset. Sign in with your new password.'
  });
});
afterEach(() => vi.useRealTimers());

describe('step 1: the email address', () => {
  it('asks for the address, prefilled from the sign-in page', () => {
    renderPage({ email: 'reader@example.com' });
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('reader@example.com');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('checks the address before asking the server', () => {
    renderPage();
    click(/Send code/);
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    type('Email address', 'nope');
    click(/Send code/);
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(authApi.forgotPassword).not.toHaveBeenCalled();
  });

  it('shows the server’s generic answer and moves on to the code', async () => {
    await toCodeStep();
    expect(authApi.forgotPassword).toHaveBeenCalledWith('reader@example.com');
    expect(screen.getByRole('status')).toHaveTextContent(SENT);
  });

  it('shows the server’s error when reset is unavailable (e.g. email not configured)', async () => {
    authApi.forgotPassword.mockRejectedValue(
      new Error('Password reset by email is not available right now. Please try again later.')
    );
    renderPage();
    type('Email address', 'reader@example.com');
    click(/Send code/);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available right now/);
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
  });
});

describe('step 2: the code', () => {
  it('accepts digits only, six of them', async () => {
    await toCodeStep();
    const field = screen.getByLabelText('6-digit code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    type('6-digit code', '12ab34567');
    expect(field).toHaveValue('123456');
    type('6-digit code', '123');
    click(/Verify code/);
    expect(screen.getByText('Enter the 6-digit code from the email.')).toBeInTheDocument();
    expect(authApi.verifyResetCode).not.toHaveBeenCalled();
  });

  it('a wrong or expired code: the server’s message, and the user can try again', async () => {
    authApi.verifyResetCode.mockRejectedValueOnce(
      new Error('The code is incorrect or has expired. Request a new code and try again.')
    );
    await toCodeStep();
    type('6-digit code', '000000');
    click(/Verify code/);
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect or has expired/);
    type('6-digit code', '123456');
    click(/Verify code/);
    await screen.findByRole('heading', { name: 'Choose a new password' });
    expect(authApi.verifyResetCode).toHaveBeenLastCalledWith('reader@example.com', '123456');
  });

  it('a new code can be asked for only after the countdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await toCodeStep();
    const resend = screen.getByRole('button', { name: /Resend code in 60s/ });
    expect(resend).toBeDisabled();
    // The countdown ticks once a second.
    for (let i = 0; i < 61; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    const ready = await screen.findByRole('button', { name: 'Resend code' });
    expect(ready).toBeEnabled();
    fireEvent.click(ready);
    await waitFor(() => expect(authApi.forgotPassword).toHaveBeenCalledTimes(2));
  });

  it('a different email starts over', async () => {
    await toCodeStep();
    click(/Use a different email/);
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
  });
});

describe('step 3: the new password', () => {
  it('checks length and that both fields match, then resets with the token from step 2', async () => {
    await toPasswordStep();
    type('New password', '12345');
    click(/Reset password/);
    expect(screen.getByText('Use at least 6 characters.')).toBeInTheDocument();
    type('New password', 'brand-new-pass');
    type('Confirm new password', 'brand-new-pasX');
    click(/Reset password/);
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    expect(authApi.resetPassword).not.toHaveBeenCalled();

    type('Confirm new password', 'brand-new-pass');
    click(/Reset password/);
    await screen.findByRole('heading', { name: 'Password reset' });
    expect(authApi.resetPassword).toHaveBeenCalledWith(TOKEN, 'brand-new-pass', 'brand-new-pass');
  });

  it('both password fields can be shown and hidden', async () => {
    await toPasswordStep();
    const toggles = screen.getAllByRole('button', { name: 'Show password' });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]);
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('type', 'password');
  });

  it('an expired or used reset: the server’s message', async () => {
    authApi.resetPassword.mockRejectedValue(
      new Error('This password reset link has expired or was already used. Please start again.')
    );
    await toPasswordStep();
    type('New password', 'brand-new-pass');
    type('Confirm new password', 'brand-new-pass');
    click(/Reset password/);
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/);
  });
});

describe('step 4: done', () => {
  it('a clear success message and a way back to sign in', async () => {
    await toPasswordStep();
    type('New password', 'brand-new-pass');
    type('Confirm new password', 'brand-new-pass');
    click(/Reset password/);
    await screen.findByRole('heading', { name: 'Password reset' });
    expect(
      screen.getByText('Your password has been reset. Sign in with your new password.')
    ).toBeInTheDocument();
    expect(screen.getByText(/signed out on every device/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Back to sign in/ }));
    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });
});

describe('secrecy', () => {
  it('the reset token is never stored or printed', async () => {
    const logs = vi.spyOn(console, 'log');
    const infos = vi.spyOn(console, 'info');
    await toPasswordStep();
    const stored = JSON.stringify({ ...window.localStorage, ...window.sessionStorage });
    expect(stored).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(logs).not.toHaveBeenCalled();
    expect(infos).not.toHaveBeenCalled();
  });
});
