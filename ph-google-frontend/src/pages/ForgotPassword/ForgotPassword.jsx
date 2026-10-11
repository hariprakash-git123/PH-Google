import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Mail, KeyRound, AlertCircle, ArrowRight, ArrowLeft, CheckCircle2 } from 'lucide-react';
import Header from '../../components/Header/Header';
import Logo from '../../components/Logo/Logo';
import PasswordField from '../../components/PasswordField/PasswordField';
import { authApi } from '../../services/authApi';
import { EMAIL_PATTERN } from '../Login/Login';
import '../Login/Login.css';

/**
 * Forgot password: email → emailed 6-digit code → new password → done.
 *
 * Every rule (expiry, guesses, resend limits, single use) is enforced by the
 * API; this page only guides the user and shows its answers. The API answers
 * the first step the same way whether or not the address has an account, and
 * so does this page. The reset token from step two lives in this component's
 * memory only — never in storage, the URL or the console.
 */

const STEPS = { EMAIL: 'email', CODE: 'code', PASSWORD: 'password', DONE: 'done' };
/** Matches the API's resend cooldown (passwordReset.resendCooldownMs). */
const RESEND_AFTER_SECONDS = 60;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 128;

export default function ForgotPassword() {
  const location = useLocation();
  const [step, setStep] = useState(STEPS.EMAIL);
  const [email, setEmail] = useState(
    typeof location.state?.email === 'string' ? location.state.email : ''
  );
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const timer = useRef(null);

  // The countdown before another code may be asked for.
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    timer.current = setTimeout(() => setResendIn(s => s - 1), 1000);
    return () => clearTimeout(timer.current);
  }, [resendIn]);

  const run = async task => {
    setError('');
    setBusy(true);
    try {
      await task();
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async e => {
    if (e) e.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setFieldErrors({
        email: address ? 'Enter a valid email address.' : 'Enter your email address.'
      });
      return;
    }
    setFieldErrors({});
    await run(async () => {
      const result = await authApi.forgotPassword(address);
      setInfo(result.message);
      setCode('');
      setStep(STEPS.CODE);
      setResendIn(RESEND_AFTER_SECONDS);
    });
  };

  const submitCode = async e => {
    e.preventDefault();
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) {
      setFieldErrors({ code: 'Enter the 6-digit code from the email.' });
      return;
    }
    setFieldErrors({});
    await run(async () => {
      const result = await authApi.verifyResetCode(email.trim(), value);
      setResetToken(result.resetToken);
      setInfo('');
      setStep(STEPS.PASSWORD);
    });
  };

  const submitPassword = async e => {
    e.preventDefault();
    const next = {};
    if (password.length < MIN_PASSWORD) {
      next.password = `Use at least ${MIN_PASSWORD} characters.`;
    } else if (password.length > MAX_PASSWORD) {
      next.password = `Use ${MAX_PASSWORD} characters or fewer.`;
    }
    if (!next.password && confirm !== password) next.confirm = 'The passwords do not match.';
    setFieldErrors(next);
    if (Object.keys(next).length) return;
    await run(async () => {
      const result = await authApi.resetPassword(resetToken, password, confirm);
      setResetToken('');
      setPassword('');
      setConfirm('');
      setInfo(result.message);
      setStep(STEPS.DONE);
    });
  };

  const startOver = () => {
    setStep(STEPS.EMAIL);
    setCode('');
    setResetToken('');
    setError('');
    setInfo('');
    setFieldErrors({});
  };

  const titles = {
    [STEPS.EMAIL]: ['Reset your password', 'Enter the email address of your PH Spectrum account.'],
    [STEPS.CODE]: ['Check your email', 'Enter the 6-digit code we sent. It expires in 10 minutes.'],
    [STEPS.PASSWORD]: [
      'Choose a new password',
      'It replaces your old password and signs you out everywhere.'
    ],
    [STEPS.DONE]: ['Password reset', '']
  };
  const [title, subtitle] = titles[step];

  return (
    <div className="ph-login-page">
      <Header />
      <main className="ph-login-main container animate-fade-in">
        <div className="ph-login-card ph-card">
          <div className="ph-login-header">
            <Logo size="medium" clickable={true} />
            <h2>{title}</h2>
            {subtitle && <p className="ph-login-subtitle">{subtitle}</p>}
          </div>

          {info && step !== STEPS.DONE && !error && (
            <div className="ph-login-info" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{info}</span>
            </div>
          )}

          {error && (
            <div className="ph-login-error" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {step === STEPS.EMAIL && (
            <form className="ph-login-form" onSubmit={requestCode} noValidate>
              <div className="ph-form-group">
                <label htmlFor="reset-email">Email address</label>
                <div className="ph-input-wrap">
                  <Mail size={16} className="ph-input-icon" aria-hidden="true" />
                  <input
                    id="reset-email"
                    type="email"
                    className="ph-form-input"
                    placeholder="name@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    autoComplete="email"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={busy}
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={fieldErrors.email ? 'reset-email-error' : undefined}
                  />
                </div>
                {fieldErrors.email && (
                  <p id="reset-email-error" className="ph-field-error">
                    {fieldErrors.email}
                  </p>
                )}
              </div>
              <button type="submit" className="ph-login-submit-btn" disabled={busy}>
                <span>{busy ? 'Sending…' : 'Send code'}</span>
                {!busy && <ArrowRight size={16} />}
              </button>
            </form>
          )}

          {step === STEPS.CODE && (
            <form className="ph-login-form" onSubmit={submitCode} noValidate>
              <div className="ph-form-group">
                <label htmlFor="reset-code">6-digit code</label>
                <div className="ph-input-wrap">
                  <KeyRound size={16} className="ph-input-icon" aria-hidden="true" />
                  <input
                    id="reset-code"
                    type="text"
                    className="ph-form-input ph-otp-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    disabled={busy}
                    aria-invalid={Boolean(fieldErrors.code)}
                    aria-describedby={fieldErrors.code ? 'reset-code-error' : undefined}
                  />
                </div>
                {fieldErrors.code && (
                  <p id="reset-code-error" className="ph-field-error">
                    {fieldErrors.code}
                  </p>
                )}
              </div>
              <button type="submit" className="ph-login-submit-btn" disabled={busy}>
                <span>{busy ? 'Checking…' : 'Verify code'}</span>
                {!busy && <ArrowRight size={16} />}
              </button>
              <div className="ph-login-row ph-login-row-split">
                <button
                  type="button"
                  className="ph-login-text-link"
                  onClick={startOver}
                  disabled={busy}
                >
                  <ArrowLeft size={14} aria-hidden="true" /> Use a different email
                </button>
                <button
                  type="button"
                  className="ph-login-text-link"
                  onClick={() => requestCode()}
                  disabled={busy || resendIn > 0}
                >
                  {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                </button>
              </div>
            </form>
          )}

          {step === STEPS.PASSWORD && (
            <form className="ph-login-form" onSubmit={submitPassword} noValidate>
              <PasswordField
                id="new-password"
                label="New password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                disabled={busy}
                error={fieldErrors.password}
                hint={`At least ${MIN_PASSWORD} characters.`}
              />
              <PasswordField
                id="confirm-password"
                label="Confirm new password"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                disabled={busy}
                error={fieldErrors.confirm}
              />
              <button type="submit" className="ph-login-submit-btn" disabled={busy}>
                <span>{busy ? 'Saving…' : 'Reset password'}</span>
                {!busy && <ArrowRight size={16} />}
              </button>
            </form>
          )}

          {step === STEPS.DONE && (
            <div className="ph-login-success animate-fade-in" role="status">
              <div className="ph-success-icon">
                <CheckCircle2 size={28} aria-hidden="true" />
              </div>
              <h3>{info || 'Your password has been reset.'}</h3>
              <p className="ph-login-subtitle">
                For your security, you have been signed out on every device.
              </p>
              <Link
                to="/login"
                state={{
                  email: email.trim(),
                  notice: 'Password reset. Sign in with your new password.'
                }}
                className="ph-login-submit-btn ph-login-link-btn"
              >
                <span>Back to sign in</span>
                <ArrowRight size={16} />
              </Link>
            </div>
          )}

          {step !== STEPS.DONE && (
            <div className="ph-login-footer">
              <span>Remembered it? </span>
              <Link to="/login" className="ph-signup-link">
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
