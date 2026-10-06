import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import Header from '../../components/Header/Header';
import { searchApi } from '../../services/searchApi';
import { useAuth } from '../../context/AuthContext';
import {
  History as HistoryIcon,
  Search,
  Trash2,
  X,
  LogIn,
  AlertCircle,
  RefreshCw
} from 'lucide-react';
import './History.css';

/**
 * Search history.
 *
 * History is per-user and private, so this page requires a signed-in account
 * and shows a sign-in prompt to guests rather than an empty list.
 */
export default function HistoryPage() {
  const { isAuthenticated, loading: authLoading } = useAuth();

  const [historyItems, setHistoryItems] = useState([]);
  const [filterQuery, setFilterQuery] = useState('');
  const [state, setState] = useState({ loading: true, requiresAuth: false, error: null });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    const result = await searchApi.getHistory({ limit: 100 });
    setHistoryItems(result.history);
    setState({ loading: false, requiresAuth: result.requiresAuth, error: result.error });
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setState({ loading: false, requiresAuth: true, error: null });
      setHistoryItems([]);
      return;
    }
    load();
  }, [authLoading, isAuthenticated, load]);

  const handleRemoveItem = async (id, e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      setHistoryItems(await searchApi.removeHistory(id));
    } catch (error) {
      setState(s => ({ ...s, error: error.message }));
    } finally {
      setBusy(false);
    }
  };

  const handleClearAll = async () => {
    setBusy(true);
    try {
      setHistoryItems(await searchApi.clearHistory());
    } catch (error) {
      setState(s => ({ ...s, error: error.message }));
    } finally {
      setBusy(false);
    }
  };

  const filteredHistory = historyItems.filter(item =>
    item.query.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <div className="ph-history-page">
      <Header />

      <main className="ph-history-main container animate-fade-in">
        <div className="ph-history-header">
          <div className="ph-history-title-wrap">
            <div className="ph-history-icon-badge">
              <HistoryIcon size={20} />
            </div>
            <div>
              <h1>Search History</h1>
              <p>Review, search, or clear your past search queries</p>
            </div>
          </div>

          {historyItems.length > 0 && (
            <button
              type="button"
              className="ph-clear-all-btn"
              onClick={handleClearAll}
              disabled={busy}
              title="Clear all search history"
            >
              <Trash2 size={15} />
              <span>Clear all</span>
            </button>
          )}
        </div>

        {state.error && (
          <div className="ph-history-error" role="alert">
            <AlertCircle size={16} />
            <span>{state.error}</span>
          </div>
        )}

        {/* Guests have no history of their own to show. */}
        {state.requiresAuth ? (
          <div className="ph-history-list-card ph-card">
            <div className="ph-history-empty">
              <LogIn size={36} className="ph-empty-icon" />
              <h3>Sign in to see your search history</h3>
              <p>
                Your history is private to your account, so it is only kept while you are signed in.
              </p>
              <Link to="/login" className="ph-btn-primary ph-history-signin-btn">
                Sign in
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="ph-history-filter-box">
              <Search size={16} className="ph-history-search-icon" />
              <input
                type="text"
                className="ph-history-filter-input"
                placeholder="Filter search history..."
                aria-label="Filter search history"
                value={filterQuery}
                onChange={e => setFilterQuery(e.target.value)}
              />
              {filterQuery && (
                <button
                  type="button"
                  className="ph-history-clear-filter"
                  onClick={() => setFilterQuery('')}
                  aria-label="Clear filter"
                >
                  <X size={15} />
                </button>
              )}
            </div>

            <div className="ph-history-list-card ph-card">
              {state.loading ? (
                <div className="ph-history-empty">
                  <RefreshCw size={28} className="ph-empty-icon animate-spin" />
                  <h3>Loading your history…</h3>
                </div>
              ) : filteredHistory.length > 0 ? (
                <div className="ph-history-items-group">
                  {filteredHistory.map(item => (
                    <div key={item.id} className="ph-history-row">
                      {/* A real link: keyboard-reachable, and the whole row stays clickable. */}
                      <Link
                        to={`/search?q=${encodeURIComponent(item.query)}`}
                        className="ph-history-left"
                      >
                        <HistoryIcon size={16} className="ph-row-icon" aria-hidden="true" />
                        <span className="ph-row-query">{item.query}</span>
                      </Link>

                      <div className="ph-history-right">
                        <span className="ph-row-time">{item.timestamp}</span>
                        {item.category && <span className="ph-row-cat-pill">{item.category}</span>}
                        <button
                          type="button"
                          className="ph-row-delete-btn"
                          onClick={e => handleRemoveItem(item.id, e)}
                          disabled={busy}
                          aria-label={`Delete ${item.query} from history`}
                          title="Remove from history"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ph-history-empty">
                  <HistoryIcon size={36} className="ph-empty-icon" />
                  <h3>
                    {filterQuery ? 'No matching search history' : 'Your search history is empty'}
                  </h3>
                  <p>Searches you perform while signed in will appear here.</p>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
