import type { ReactNode } from 'react'

export type TabGlyphName = 'home' | 'apps' | 'invoices' | 'question' | 'more'

/**
 * The narrow layout's tab-bar glyphs (docs/specs/00-shell-and-login.md §4.5),
 * drawn the way the delivered mobile frames draw theirs: 17 px, a 1.8 stroke
 * on a 24-unit box, `currentColor`, so the tab decides the ink with a token
 * class. Decoration only — every tab carries a visible label, which is its
 * accessible name. « Plus » is the mock's own three rules.
 */
const PATHS: Record<TabGlyphName, ReactNode> = {
  // A house: a roof over a body with a door.
  home: (
    <>
      <path d="M4.5 10.5L12 4.5l7.5 6V19a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  // Four tiles — the applications of the instance.
  apps: (
    <>
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.5" />
    </>
  ),
  // An invoice: a page with a torn foot and two ruled lines.
  invoices: (
    <>
      <path d="M6.5 3.5h11v17l-2.75-1.75L12 20.5l-2.75-1.75L6.5 20.5z" />
      <path d="M9.5 8.5h5M9.5 12h5" />
    </>
  ),
  // A question mark in a circle.
  question: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.75 9.5a2.25 2.25 0 1 1 3.1 2.08c-.54.23-.85.76-.85 1.34v.58" />
      <path d="M12 16.5h.01" />
    </>
  ),
  // The mock's « Plus »: three rules.
  more: <path d="M6.5 8.5h11M6.5 12h11M6.5 15.5h11" />,
}

export interface TabGlyphProps {
  name: TabGlyphName
}

export function TabGlyph({ name }: TabGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
