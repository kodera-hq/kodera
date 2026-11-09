import type { ReactNode } from 'react'

/**
 * The content header above the page (P01 of the product reference;
 * `design specification` `design/reference/p01-shell.html`, `.head`): where the
 * person is, and the few actions that belong to it. Presentational only — the
 * caller decides the title (`src/app/contentTitle.ts`), the leading control
 * (the sidebar toggle) and the actions (help, the one primary action of a page).
 *
 * The title is text, not a heading: the page below carries its own `h1`, and a
 * second heading naming the same place would be two to skip
 * (docs/specs/shell-fidelity.md). At the top level a `header` is the page's
 * banner landmark, so render one TopBar per page; it is named so it is told
 * apart from the rail's and the sidebar's `nav` landmarks.
 *
 * `shell-header-height` tall (56 px), the approved console height; the
 * reference draws 60 px, a deviation listed for the owner, not taken here.
 */
export interface TopBarProps {
  /** The landmark's accessible name, from the caller's catalogue. */
  label: string
  /** Where the person is: the current area, never a second page heading. */
  title: ReactNode
  /** One line of context after the title (a member count, a date); truncated. */
  subtitle?: ReactNode
  /** Before the title: the sidebar toggle. */
  leading?: ReactNode
  /** After the title, right-aligned: help, then at most one primary action. */
  actions?: ReactNode
}

export function TopBar({ label, title, subtitle, leading, actions }: TopBarProps) {
  return (
    <header
      aria-label={label}
      className="flex h-shell-header-height shrink-0 items-center gap-3 border-b border-c-border-soft bg-c-surface px-6"
    >
      {leading}
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="min-w-0 truncate text-md font-semibold text-c-ink">{title}</span>
        {subtitle === undefined ? null : (
          <span className="min-w-0 truncate text-sm text-c-ink-3">{subtitle}</span>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  )
}
