import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { RefreshCw, ShieldOff } from 'lucide-react';
import Header from '../Header/Header';
import './ProtectedRoute.css';

/** Shown instead of a protected page the signed-in account may not open. */
function AccessNotice({ title, children, retry = false }) {
  return (
    <div className="ph-access-page">
      <Header />
      <main className="ph-access-main container animate-fade-in">
        <div className="ph-access-card ph-card" role="alert">
          <ShieldOff size={32} className="ph-access-icon" aria-hidden="true" />
          <h1>{title}</h1>
          <p>{children}</p>
          <div className="ph-access-actions">
            <Link to="/" className="ph-btn-primary">
              Back to search
            </Link>
            {retry && (
              <button
                type="button"
                className="ph-btn-secondary"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * ProtectedRoute — wraps a route and ensures the user is authenticated.
 *
 * Guests are sent to /login (and come back here after signing in). With
 * `adminOnly`, the page renders only for a role the server has confirmed in
 * this session; anyone else gets an access-denied page. This only decides what
 * the browser shows — every admin API call is authorised by the backend.
 */
export default function ProtectedRoute({ children, adminOnly = false }) {
  const { isAuthenticated, isAdmin, isVerified, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="ph-access-loading" role="status" aria-label="Checking access">
        <RefreshCw size={24} className="animate-spin" aria-hidden="true" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (adminOnly && !isVerified) {
    return (
      <AccessNotice title="Could not confirm your access" retry>
        The server could not be reached to check your account. Try again in a moment.
      </AccessNotice>
    );
  }

  if (adminOnly && !isAdmin) {
    return (
      <AccessNotice title="Access denied">
        Admin access is required to open this page. Your account does not have it.
      </AccessNotice>
    );
  }

  return children;
}
