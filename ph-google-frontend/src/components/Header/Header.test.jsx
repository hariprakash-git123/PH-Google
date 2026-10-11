import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Header from './Header';

/** A search typed in the header on the Images tab stays on the Images tab. */

vi.mock('../../services/searchApi', () => ({
  searchApi: { getSuggestions: vi.fn(async () => []) }
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, isAdmin: false, logout: vi.fn() })
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

const renderHeader = props =>
  render(
    <MemoryRouter initialEntries={['/search?q=cats&category=images']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Header searchQuery="cats" {...props} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

const search = text => {
  const box = screen.getByLabelText('Search the web');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.submit(box.closest('form'));
};

describe('the header search box', () => {
  it('on the Images tab, a new search stays on the Images tab', () => {
    renderHeader({ searchCategory: 'images' });
    search('dogs');
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=dogs&category=images');
  });

  it('elsewhere, a new search goes to All results as before', () => {
    renderHeader();
    search('dogs');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/search\?q=dogs$/);
  });
});
