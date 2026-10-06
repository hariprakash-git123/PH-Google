import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Header from '../../components/Header/Header';
import Logo from '../../components/Logo/Logo';
import { Mail, Lock, AlertCircle, ArrowRight, ShieldCheck } from 'lucide-react';
import './Login.css';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  // Where a protected page sent the user from; only same-site paths are followed.
  const from = location.state?.from;
  const returnTo =
    typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
  const { login, isAuthenticated } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(email, password);
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
              Sign in to sync history, preferences and saved results.
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="ph-login-error" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <form className="ph-login-form" onSubmit={handleSubmit}>
            <div className="ph-form-group">
              <label htmlFor="email">Email address</label>
              <div className="ph-input-wrap">
                <Mail size={16} className="ph-input-icon" />
                <input
                  id="email"
                  type="email"
                  className="ph-form-input"
                  placeholder="name@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <div className="ph-form-group">
              <label htmlFor="password">Password</label>
              <div className="ph-input-wrap">
                <Lock size={16} className="ph-input-icon" />
                <input
                  id="password"
                  type="password"
                  className="ph-form-input"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  minLength={6}   
                />
              </div>
            </div>

            <button type="submit" className="ph-login-submit-btn" disabled={isLoading}>
              <span>{isLoading ? 'Signing in...' : 'Continue'}</span>
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
