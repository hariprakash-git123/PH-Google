import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard,
  Bot,
  Database,
  BarChart3,
  Settings,
  ArrowLeft,
  Menu,
  X
} from 'lucide-react';
import Logo from '../Logo/Logo';
import './AdminSidebar.css';

export default function AdminSidebar({ activeTab = 'overview', onTabChange }) {
  const [isOpen, setIsOpen] = useState(false);

  // Escape closes the drawer on small screens.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = e => e.key === 'Escape' && setIsOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const menuItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'crawlers', label: 'Crawlers', icon: Bot },
    { id: 'index', label: 'Index', icon: Database },
    { id: 'analytics', label: 'Search analytics', icon: BarChart3 },
    { id: 'settings', label: 'System settings', icon: Settings }
  ];

  return (
    <>
      {/* Mobile Header Toggle */}
      <div className="ph-admin-mobile-bar">
        <Logo size="small" />
        <button
          type="button"
          className="ph-admin-menu-toggle"
          onClick={() => setIsOpen(!isOpen)}
          aria-label={isOpen ? 'Close admin menu' : 'Open admin menu'}
          aria-expanded={isOpen}
          aria-controls="ph-admin-sidebar"
        >
          {isOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
      </div>

      <aside id="ph-admin-sidebar" className={`ph-admin-sidebar ${isOpen ? 'mobile-open' : ''}`}>
        <div className="ph-admin-sidebar-top">
          <div className="ph-admin-logo-wrapper">
            <Logo size="small" />
            <span className="ph-admin-badge">OPS</span>
          </div>

          <nav className="ph-admin-nav" aria-label="Admin Navigation">
            {menuItems.map(item => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`ph-admin-nav-item ${isActive ? 'active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => {
                    onTabChange(item.id);
                    setIsOpen(false);
                  }}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="ph-admin-sidebar-bottom">
          <Link to="/" className="ph-admin-back-btn">
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back to search</span>
          </Link>
        </div>
      </aside>

      {/* Backdrop for mobile view */}
      {isOpen && (
        <div className="ph-admin-backdrop" onClick={() => setIsOpen(false)} aria-hidden="true" />
      )}
    </>
  );
}
