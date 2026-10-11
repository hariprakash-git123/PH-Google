import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { History, Settings, Grid, User, ShieldAlert, Sparkles, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import Logo from '../Logo/Logo';
import SearchBar from '../SearchBar/SearchBar';
import './Header.css';

const navClass = ({ isActive }) => `ph-header-link${isActive ? ' active' : ''}`;

/**
 * Closes a dropdown on Escape or on a click/tap outside `ref`.
 * Escape returns focus to the button that opened it.
 */
function useDismiss(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = e => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector('button')?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen, ref]);
}

/**
 * The site header shared by every user-facing page.
 *
 * Left: the logo (linking home) on every page but the homepage, whose hero
 * already carries the large logo; on results it is followed by the search box.
 * Right: History, Settings, the apps menu and the account menu.
 *
 * `searchCategory`: a search typed here stays on that results tab (Images).
 */
export default function Header({ searchQuery = '', searchCategory = null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isAuthenticated, isAdmin, logout } = useAuth();
  const isHomePage = location.pathname === '/';
  const isSearchResults = location.pathname.startsWith('/search');

  const [showAppsMenu, setShowAppsMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const appsRef = useRef(null);
  const userRef = useRef(null);
  useDismiss(showAppsMenu, setShowAppsMenu, appsRef);
  useDismiss(showUserMenu, setShowUserMenu, userRef);

  const handleLogout = () => {
    logout();
    setShowUserMenu(false);
    navigate('/');
  };

  return (
    <header className={`ph-header ${isSearchResults ? 'ph-header-sticky' : ''}`}>
      <div className="ph-header-container">
        {/* Left Section */}
        <div className="ph-header-left">
          {isSearchResults ? (
            <div className="ph-header-search-wrap">
              <Logo size="small" />
              <SearchBar
                initialValue={searchQuery}
                variant="header"
                showSubmitButton={true}
                onSearchSubmit={
                  searchCategory
                    ? text =>
                        navigate(
                          `/search?q=${encodeURIComponent(text.trim())}&category=${encodeURIComponent(searchCategory)}`
                        )
                    : undefined
                }
              />
            </div>
          ) : (
            !isHomePage && <Logo size="small" />
          )}
        </div>

        {/* Right Section */}
        <nav className="ph-header-right" aria-label="Main navigation">
          <NavLink to="/history" className={navClass} title="Search History" aria-label="History">
            <History size={18} aria-hidden="true" />
            <span className="ph-nav-text-mobile">History</span>
          </NavLink>

          <NavLink to="/settings" className={navClass} title="Settings" aria-label="Settings">
            <Settings size={18} aria-hidden="true" />
            <span className="ph-nav-text-mobile">Settings</span>
          </NavLink>

          {/* Apps Grid Menu Dropdown */}
          <div className="ph-apps-menu-wrapper" ref={appsRef}>
            <button
              type="button"
              className="ph-header-icon-btn"
              onClick={() => {
                setShowAppsMenu(open => !open);
                setShowUserMenu(false);
              }}
              aria-label="PH apps"
              aria-haspopup="true"
              aria-expanded={showAppsMenu}
              title="PH Apps"
            >
              <Grid size={19} aria-hidden="true" />
            </button>

            {showAppsMenu && (
              <div className="ph-apps-dropdown animate-fade-in">
                <div className="ph-apps-header">PH Ecosystem</div>
                {/* Choosing an entry closes the menu. */}
                <div className="ph-apps-grid" onClick={() => setShowAppsMenu(false)}>
                  <Link to="/search?q=AI+Search" className="ph-app-item">
                    <div className="ph-app-icon ai">
                      <Sparkles size={18} aria-hidden="true" />
                    </div>
                    <span>PH Insight</span>
                  </Link>
                  <Link to="/history" className="ph-app-item">
                    <div className="ph-app-icon history">
                      <History size={18} aria-hidden="true" />
                    </div>
                    <span>History</span>
                  </Link>
                  {/* Only for a role the server has confirmed; the API enforces it too. */}
                  {isAdmin && (
                    <Link to="/admin" className="ph-app-item">
                      <div className="ph-app-icon admin">
                        <ShieldAlert size={18} aria-hidden="true" />
                      </div>
                      <span>Admin Ops</span>
                    </Link>
                  )}
                  <Link to="/settings" className="ph-app-item">
                    <div className="ph-app-icon settings">
                      <Settings size={18} aria-hidden="true" />
                    </div>
                    <span>Settings</span>
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* User Avatar / Auth Menu */}
          <div className="ph-apps-menu-wrapper" ref={userRef}>
            {isAuthenticated && user ? (
              <>
                <button
                  type="button"
                  className="ph-user-avatar-btn"
                  onClick={() => {
                    setShowUserMenu(open => !open);
                    setShowAppsMenu(false);
                  }}
                  aria-label={`Account menu for ${user.name}`}
                  aria-haspopup="true"
                  aria-expanded={showUserMenu}
                  title={`Signed in as ${user.name}`}
                >
                  <div className="ph-avatar-circle ph-avatar-logged-in" aria-hidden="true">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                </button>

                {showUserMenu && (
                  <div className="ph-apps-dropdown ph-user-dropdown animate-fade-in">
                    <div className="ph-user-info">
                      <div
                        className="ph-avatar-circle ph-avatar-logged-in ph-avatar-large"
                        aria-hidden="true"
                      >
                        {user.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <strong>{user.name}</strong>
                        <span className="ph-user-email">{user.email}</span>
                        {isAdmin && <span className="ph-admin-badge">Admin</span>}
                      </div>
                    </div>
                    <button type="button" className="ph-logout-btn" onClick={handleLogout}>
                      <LogOut size={15} aria-hidden="true" />
                      <span>Sign out</span>
                    </button>
                  </div>
                )}
              </>
            ) : (
              <Link to="/login" className="ph-user-avatar-btn" aria-label="Sign in" title="Sign in">
                <div className="ph-avatar-circle">
                  <User size={17} aria-hidden="true" />
                </div>
              </Link>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
