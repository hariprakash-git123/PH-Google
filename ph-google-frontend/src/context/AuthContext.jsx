import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../services/authApi';

const AuthContext = createContext(null);

const TOKEN_KEY = 'ph_token';
const USER_KEY = 'ph_user';

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode); the session still works in memory.
  }
}

/**
 * AuthProvider — holds the signed-in user and JWT.
 *
 * On load it restores the session from localStorage and then revalidates the
 * token against the API, so an expired or revoked token cannot leave the UI
 * believing it is signed in.
 *
 * The copy in localStorage is only a display hint: it can be edited in the
 * browser. `isAdmin` is therefore true only once the server has returned the
 * profile in this session (on restore, login or signup). The admin API checks
 * the role itself on every request regardless.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  // True once this session's user came from the server, not from storage.
  const [verified, setVerified] = useState(false);

  const clearSession = useCallback(() => {
    setToken(null);
    setUser(null);
    setVerified(false);
    writeStored(TOKEN_KEY, null);
    writeStored(USER_KEY, null);
  }, []);

  useEffect(() => {
    let active = true;

    async function restore() {
      const savedToken = readStored(TOKEN_KEY);
      const savedUser = readStored(USER_KEY);

      if (!savedToken || !savedUser) {
        if (active) setLoading(false);
        return;
      }

      // Show the stored session immediately so the UI does not flicker.
      try {
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
      } catch {
        clearSession();
        if (active) setLoading(false);
        return;
      }

      // Then confirm the token is still valid.
      try {
        const data = await authApi.getProfile();
        if (!active) return;
        setUser(data.user);
        setVerified(true);
        writeStored(USER_KEY, JSON.stringify(data.user));
      } catch (error) {
        // 401 means the token expired or the account is gone; anything else
        // (e.g. the API being down) should not sign the user out.
        if (active && error.status === 401) clearSession();
      } finally {
        if (active) setLoading(false);
      }
    }

    restore();
    return () => {
      active = false;
    };
  }, [clearSession]);

  const applySession = useCallback(data => {
    setToken(data.token);
    setUser(data.user);
    setVerified(true);
    writeStored(TOKEN_KEY, data.token);
    writeStored(USER_KEY, JSON.stringify(data.user));
    return data.user;
  }, []);

  const login = useCallback(
    async (email, password) => {
      return applySession(await authApi.login(email, password));
    },
    [applySession]
  );

  const register = useCallback(
    async (name, email, password) => {
      return applySession(await authApi.register(name, email, password));
    },
    [applySession]
  );

  const logout = useCallback(() => {
    clearSession();
  }, [clearSession]);

  const value = {
    user,
    token,
    loading,
    isAuthenticated: !!token,
    isVerified: verified,
    isAdmin: verified && user?.role === 'admin',
    login,
    register,
    logout
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * useAuth hook — access auth state from any component.
 * Example: const { user, isAuthenticated, login, logout } = useAuth();
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
