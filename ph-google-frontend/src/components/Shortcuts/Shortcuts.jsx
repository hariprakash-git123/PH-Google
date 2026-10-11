import React, { useEffect, useId, useRef, useState } from 'react';
import { MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { faviconUrlFor } from '../../utils/favicon';
import {
  MAX_NAME_LENGTH,
  MAX_SHORTCUTS,
  loadShortcuts,
  newShortcutId,
  parseShortcutUrl,
  saveShortcuts,
  shortcutKey,
  shortcutName
} from '../../services/shortcuts';
import './Shortcuts.css';

/**
 * Website shortcuts on the homepage: a tile per site, and one to add another.
 *
 * A shortcut is an ordinary link, marked like a search result
 * (`data-ph-result`), so inside PH Spectrum a plain click opens the site in
 * the PH tab it was clicked in — as a result does — and Ctrl/Cmd- or
 * middle-click open a new browser tab as usual (see BrowserShell).
 *
 * The list is kept in this browser only (services/shortcuts.js).
 */

/** The site's own icon, or its first letter when there is none or it will not load. */
function ShortcutIcon({ url, name }) {
  const src = faviconUrlFor(url);
  const [failed, setFailed] = useState(null);
  if (!src || failed === src) {
    return (
      <span className="ph-shortcut-letter" aria-hidden="true">
        {(name || '?').trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable="false"
      onError={() => setFailed(src)}
    />
  );
}

/** Add or edit one shortcut. */
function ShortcutDialog({ initial, items, onSave, onCancel }) {
  const titleId = useId();
  const nameId = useId();
  const urlId = useId();
  const errorId = useId();
  const editing = Boolean(initial);
  const [name, setName] = useState(initial ? initial.name : '');
  const [url, setUrl] = useState(initial ? initial.url : '');
  const [error, setError] = useState(null);
  const dialogRef = useRef(null);
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Escape cancels; Tab stays inside the dialog.
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      } else if (event.key === 'Tab' && dialogRef.current) {
        const focusable = [...dialogRef.current.querySelectorAll('input, button:not([disabled])')];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = event => {
    event.preventDefault();
    const parsed = parseShortcutUrl(url);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const key = shortcutKey(parsed.url);
    const same = items.find(
      item => shortcutKey(item.url) === key && (!initial || item.id !== initial.id)
    );
    if (same) {
      setError(`You already have a shortcut for this site: ${same.name}.`);
      return;
    }
    onSave({ name: shortcutName(name, parsed.url), url: parsed.url });
  };

  return (
    <div className="ph-shortcut-dialog-backdrop" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="ph-shortcut-dialog ph-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={event => event.stopPropagation()}
      >
        <h2 id={titleId}>{editing ? 'Edit shortcut' : 'Add shortcut'}</h2>
        <form onSubmit={submit} noValidate>
          <label htmlFor={nameId}>Name</label>
          <input
            ref={nameRef}
            id={nameId}
            type="text"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Optional — the site’s name is used"
            autoComplete="off"
            onChange={event => setName(event.target.value)}
          />
          <label htmlFor={urlId}>URL</label>
          <input
            id={urlId}
            type="url"
            inputMode="url"
            value={url}
            placeholder="https://example.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onChange={event => {
              setUrl(event.target.value);
              if (error) setError(null);
            }}
          />
          {error && (
            <p id={errorId} className="ph-shortcut-error" role="alert">
              {error}
            </p>
          )}
          <div className="ph-shortcut-dialog-actions">
            <button type="button" className="ph-btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="ph-btn-primary" disabled={!url.trim()}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Shortcuts() {
  const [items, setItems] = useState(loadShortcuts);
  // null, { mode: 'add' }, or { mode: 'edit', item }
  const [dialog, setDialog] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [notice, setNotice] = useState(null);
  const sectionRef = useRef(null);
  // Where focus goes back to when the dialog or menu closes.
  const returnFocus = useRef(null);

  const commit = next => {
    setItems(next);
    setNotice(
      saveShortcuts(next)
        ? null
        : 'Shortcuts could not be saved in this browser; the change lasts until you leave the page.'
    );
  };

  // The open menu closes on Escape or a click elsewhere.
  useEffect(() => {
    if (!menuFor) return undefined;
    const onPointer = event => {
      if (!event.target.closest || !event.target.closest('.ph-shortcut-menu-wrap'))
        setMenuFor(null);
    };
    const onKey = event => {
      if (event.key !== 'Escape') return;
      setMenuFor(null);
      returnFocus.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  const closeDialog = () => {
    setDialog(null);
    // After the dialog has gone, so focus lands on the page again.
    setTimeout(() => {
      const target = returnFocus.current;
      if (target && target.isConnected) target.focus();
      else sectionRef.current?.querySelector('.ph-shortcut-add')?.focus();
    }, 0);
  };

  const save = ({ name, url }) => {
    if (dialog.mode === 'edit') {
      commit(items.map(item => (item.id === dialog.item.id ? { ...item, name, url } : item)));
    } else {
      commit([...items, { id: newShortcutId(items), name, url }]);
    }
    closeDialog();
  };

  const remove = item => {
    setMenuFor(null);
    commit(items.filter(other => other.id !== item.id));
    returnFocus.current = null;
    setTimeout(
      () => sectionRef.current?.querySelector('.ph-shortcut-add, .ph-shortcut-link')?.focus(),
      0
    );
  };

  return (
    <section ref={sectionRef} className="ph-shortcuts" aria-label="Website shortcuts">
      <ul className="ph-shortcuts-grid">
        {items.map(item => (
          <li key={item.id} className="ph-shortcut">
            <a
              className="ph-shortcut-link"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              data-ph-result=""
              title={item.url}
            >
              <span className="ph-shortcut-icon">
                <ShortcutIcon url={item.url} name={item.name} />
              </span>
              <span className="ph-shortcut-name">{item.name}</span>
            </a>
            <div className="ph-shortcut-menu-wrap">
              <button
                type="button"
                className="ph-shortcut-menu-btn"
                aria-label={`Edit or remove ${item.name}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === item.id}
                onClick={event => {
                  returnFocus.current = event.currentTarget;
                  setMenuFor(open => (open === item.id ? null : item.id));
                }}
              >
                <MoreVertical size={15} aria-hidden="true" />
              </button>
              {menuFor === item.id && (
                <div className="ph-shortcut-menu" role="menu" aria-label={`${item.name} shortcut`}>
                  <button
                    type="button"
                    role="menuitem"
                    autoFocus
                    onClick={() => {
                      setMenuFor(null);
                      setDialog({ mode: 'edit', item });
                    }}
                  >
                    <Pencil size={14} aria-hidden="true" /> Edit shortcut
                  </button>
                  <button type="button" role="menuitem" onClick={() => remove(item)}>
                    <Trash2 size={14} aria-hidden="true" /> Remove
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
        {items.length < MAX_SHORTCUTS && (
          <li className="ph-shortcut">
            <button
              type="button"
              className="ph-shortcut-link ph-shortcut-add"
              onClick={event => {
                returnFocus.current = event.currentTarget;
                setDialog({ mode: 'add' });
              }}
            >
              <span className="ph-shortcut-icon">
                <Plus size={20} aria-hidden="true" />
              </span>
              <span className="ph-shortcut-name">Add shortcut</span>
            </button>
          </li>
        )}
      </ul>

      {notice && (
        <p className="ph-shortcuts-notice" role="status">
          {notice}
        </p>
      )}

      {dialog && (
        <ShortcutDialog
          initial={dialog.mode === 'edit' ? dialog.item : null}
          items={items}
          onSave={save}
          onCancel={closeDialog}
        />
      )}
    </section>
  );
}
