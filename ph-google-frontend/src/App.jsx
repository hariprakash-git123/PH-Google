import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute/ProtectedRoute';
import BrowserShell from './components/BrowserShell/BrowserShell';
import Home from './pages/Home/Home';
import SearchResults from './pages/SearchResults/SearchResults';
import Login from './pages/Login/Login';
import Signup from './pages/Signup/Signup';
import History from './pages/History/History';
import Settings from './pages/Settings/Settings';
import Admin from './pages/Admin/Admin';

export default function App() {
  return (
    <AuthProvider>
      {/* The routes are the first tab of the in-app browser. */}
      <BrowserShell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/search" element={<SearchResults />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route
            path="/admin"
            element={
              <ProtectedRoute adminOnly>
                <Admin />
              </ProtectedRoute>
            }
          />
          {/* Fallback route */}
          <Route path="*" element={<Home />} />
        </Routes>
      </BrowserShell>
    </AuthProvider>
  );
}
