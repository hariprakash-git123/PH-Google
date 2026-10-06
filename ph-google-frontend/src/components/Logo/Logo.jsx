import React from 'react';
import { Link } from 'react-router-dom';
import './Logo.css';

/**
 * The PH mark — a line-drawn hummingbird carrying a leaf sprig.
 *
 * Drawn inline so it is sharp at every size and needs no network request.
 * The bird's lines follow the text colour (charcoal on ivory, ivory on
 * charcoal); the sprig keeps its leaf green in both themes.
 * public/favicon.svg is the same drawing with fixed colours.
 *
 * Decorative next to the wordmark, so it is hidden from assistive tech;
 * pass a `title` when the mark is used on its own.
 */
export function LogoMark({ size = 32, title, className = '' }) {
  // Thin lines vanish at header size, so small marks draw a heavier line.
  const strokeWidth = size <= 40 ? 10 : 7;

  return (
    <svg
      className={`ph-logo-mark ${className}`}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <g
        className="ph-logo-mark-bird"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* wing tip → back → crown → beak */}
        <path d="M38 8C58 30 78 56 96 72C102 58 118 50 132 55C144 59 162 61 182 61" />
        {/* wing leading edge, sweeping down to the tail */}
        <path d="M38 8C16 38 20 78 46 100C62 116 68 138 64 164" />
        {/* beak underside → throat → belly → tail feather */}
        <path d="M182 61L146 69C132 75 125 94 119 110C109 136 86 150 60 156C40 160 24 162 10 162" />
        {/* inner wing line crossing the body */}
        <path d="M96 72C78 84 64 106 58 128C54 144 46 156 34 165" />
      </g>
      <g className="ph-logo-mark-sprig">
        <path d="M182 60C186 54 188 48 188 40" strokeWidth="4" strokeLinecap="round" />
        <ellipse cx="183" cy="44" rx="4" ry="7" transform="rotate(-35 183 44)" />
        <ellipse cx="193" cy="46" rx="4" ry="7" transform="rotate(40 193 46)" />
        <ellipse cx="181" cy="55" rx="4" ry="7" transform="rotate(-50 181 55)" />
        <ellipse cx="193" cy="57" rx="4" ry="7" transform="rotate(55 193 57)" />
        <ellipse cx="187" cy="34" rx="3.5" ry="6" />
      </g>
    </svg>
  );
}

/**
 * PH Spectrum logo: mark + wordmark.
 *
 * @param {'small'|'medium'|'large'} size
 * @param {boolean} showTagline  Show the line under the wordmark.
 * @param {boolean} clickable    Wrap in a link to the homepage.
 * @param {string} as  Element used for the wordmark. Defaults to a span so the
 *                     logo in the header adds no heading to the outline; the
 *                     page that owns the wordmark as its title passes "h1".
 */
export default function Logo({
  size = 'medium',
  showTagline = false,
  clickable = true,
  as: TitleTag = 'span'
}) {
  const markSize = { small: 34, medium: 42, large: 88 }[size] || 42;

  const logoContent = (
    <div className={`ph-logo-container ph-logo-${size}`}>
      <LogoMark size={markSize} />
      <div className="ph-logo-text-group">
        <TitleTag className="ph-logo-title">
          PH <span className="ph-logo-highlight">Spectrum</span>
        </TitleTag>
        {showTagline && <span className="ph-logo-tagline">Search beyond keywords.</span>}
      </div>
    </div>
  );

  if (clickable) {
    return (
      <Link to="/" className="ph-logo-link" aria-label="PH Spectrum Home">
        {logoContent}
      </Link>
    );
  }

  return logoContent;
}
