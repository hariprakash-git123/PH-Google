import React, { useState } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';

/**
 * A password input with a show/hide button, in the sign-in form's style
 * (Login.css). The button is a real button with a name and a pressed state,
 * so it works from the keyboard and with screen readers; it never submits
 * the form.
 *
 * @param {Object} props  id, label, value, onChange(value), autoComplete,
 *                        disabled, error (message shown under the field), hint
 */
export default function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete = 'current-password',
  disabled = false,
  error = '',
  hint = '',
  autoFocus = false
}) {
  const [visible, setVisible] = useState(false);
  const describedBy = [error ? `${id}-error` : '', hint ? `${id}-hint` : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className="ph-form-group">
      <label htmlFor={id}>{label}</label>
      <div className="ph-input-wrap">
        <Lock size={16} className="ph-input-icon" aria-hidden="true" />
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className="ph-form-input ph-form-input-with-toggle"
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy || undefined}
        />
        <button
          type="button"
          className="ph-password-toggle"
          onClick={() => setVisible(v => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={id}
          disabled={disabled}
          title={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="ph-field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="ph-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
