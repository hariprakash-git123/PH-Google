import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Header from '../../components/Header/Header';
import Logo from '../../components/Logo/Logo';
import { Mail, Lock, User, AlertCircle, ArrowRight } from 'lucide-react';
import '../Login/Login.css';

export default function Signup() {
  const navigate = useNavigate();
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);

    try {
      await register(name, email, password);
      navigate('/');
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
            <h2>Create your account</h2>
            <p className="ph-login-subtitle">
              Join PH Spectrum to save history, preferences and bookmarks.
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
              <label htmlFor="name">Full name</label>
              <div className="ph-input-wrap">
                <User size={16} className="ph-input-icon" />
                <input
                  id="name"
                  type="text"
                  className="ph-form-input"
                  placeholder="Your full name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  disabled={isLoading}
                  minLength={2}
                />
              </div>
            </div>

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
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  minLength={6}
                />
              </div>
            </div>

            <div className="ph-form-group">
              <label htmlFor="confirmPassword">Confirm password</label>
              <div className="ph-input-wrap">
                <Lock size={16} className="ph-input-icon" />
                <input
                  id="confirmPassword"
                  type="password"
                  className="ph-form-input"
                  placeholder="Re-enter your password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  minLength={6}
                />
              </div>
            </div>

            <button type="submit" className="ph-login-submit-btn" disabled={isLoading}>
              <span>{isLoading ? 'Creating account...' : 'Create Account'}</span>
              {!isLoading && <ArrowRight size={16} />}
            </button>
          </form>

          <div className="ph-login-footer">
            <span>Already have an account? </span>
            <Link to="/login" className="ph-signup-link">
              Sign in
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
