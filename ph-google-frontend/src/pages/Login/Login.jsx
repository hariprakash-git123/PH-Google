import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Header from '../../components/Header/Header';
import Logo from '../../components/Logo/Logo';
import PasswordField from '../../components/PasswordField/PasswordField';
import { Mail, AlertCircle, ArrowRight, ShieldCheck, CheckCircle2 } from 'lucide-react';
import './Login.css';

/** The same shape the API accepts (utils/validators.parseEmail). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  // Where a protected page sent the user from; only same-site paths are followed.
  const from = location.state?.from;
  const returnTo =
    typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
  // Shown after a password reset sends the user back here.
  const notice = typeof location.state?.notice === 'string' ? location.state.notice : '';
  const { login, isAuthenticated } = useAuth();
  const [email, setEmail] = useState(
    typeof location.state?.email === 'string' ? location.state.email : ''
  );
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // If already logged in, redirect to home
  if (isAuthenticated) {
    return (
      <div className="ph-login-page">
        <Header />
        <main className="ph-login-main container animate-fade-in">
          <div className="ph-login-card ph-card">
            <div className="ph-login-header">
              <Logo size="medium" clickable={true} />
            </div>
            <div className="ph-login-success animate-fade-in">
              <div className="ph-success-icon">
                <ShieldCheck size={28} />
              </div>
              <h3>You're already signed in!</h3>
              <button
                className="ph-btn-primary"
                onClick={() => navigate('/')}
                style={{ width: '100%', marginTop: '16px' }}
              >
                Return to Search Home
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const validate = () => {
    const next = {};
    const address = email.trim();
    if (!address) next.email = 'Enter your email address.';
    else if (!EMAIL_PATTERN.test(address)) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    if (!validate()) return;
    setIsLoading(true);

    try {
      await login(email.trim(), password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="ph-login-page">
      <Header />

      <main className="ph-login-main container animate-fade-in">
        <div className="ph-login-card ph-card">
          <div className="ph-login-header">
            <Logo size="medium" clickable={true} />
            <h2>Sign in to PH Spectrum</h2>
            <p className="ph-login-subtitle">
              Sign in to sync your search history and preferences.
            </p>
          </div>

          {notice && !error && (
            <div className="ph-login-info" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div className="ph-login-error" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <form className="ph-login-form" onSubmit={handleSubmit} noValidate>
            <div className="ph-form-group">
              <label htmlFor="email">Email address</label>
              <div className="ph-input-wrap">
                <Mail size={16} className="ph-input-icon" aria-hidden="true" />
                <input
                  id="email"
                  type="email"
                  className="ph-form-input"
                  placeholder="name@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={isLoading}
                  aria-invalid={Boolean(fieldErrors.email)}
                  aria-describedby={fieldErrors.email ? 'email-error' : undefined}
                />
              </div>
              {fieldErrors.email && (
                <p id="email-error" className="ph-field-error">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            <PasswordField
              id="password"
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              disabled={isLoading}
              error={fieldErrors.password}
            />

            <div className="ph-login-row">
              <Link
                to="/forgot-password"
                state={{ email: email.trim() }}
                className="ph-login-text-link"
              >
                Forgot password?
              </Link>
            </div>

            <button type="submit" className="ph-login-submit-btn" disabled={isLoading}>
              <span>{isLoading ? 'Signing in…' : 'Sign in'}</span>
              {!isLoading && <ArrowRight size={16} />}
            </button>
          </form>

          <div className="ph-login-footer">
            <span>Don't have an account? </span>
            <Link to="/signup" className="ph-signup-link">
              Create one
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
