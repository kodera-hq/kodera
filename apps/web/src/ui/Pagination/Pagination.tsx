import { Button } from '../Button/Button'

export interface PaginationProps {
  /** Accessible name for the control group. */
  ariaLabel: string
  /** From the Core API's `has_more` on the current page. */
  hasMore: boolean
  /** Whether a `previous` cursor exists at all — the console keeps no page
   * count, so this is the only way "first page" is known. */
  hasPrevious: boolean
  previousLabel: string
  nextLabel: string
  onPrevious: () => void
  onNext: () => void
  /**
   * Text for the live region announced after a page change, set by the
   * caller once the new cursor's rows have rendered. There is no page number
   * to read out — cursor-only pagination carries no total (docs/dev's Core
   * API contract) — so this is whatever the caller decided is worth saying,
   * or nothing at all.
   */
  announcement?: string
}

/**
 * Cursor-only, on purpose: `next_cursor` and `has_more` are all the Core API
 * gives a list endpoint, and a page **number** implies a total the API does
 * not send and the console must not invent. No page numbers, no "sur N
 * pages" — two buttons and nothing else.
 *
 * Keyboard: `Tab` reaches each button in order, `Enter`/`Space` activates it.
 * `disabled` removes a button from the tab order the same way it does on
 * `Button` — there is nothing to skip to when there is no previous or no
 * next page.
 */
export function Pagination({
  ariaLabel,
  hasMore,
  hasPrevious,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  announcement,
}: PaginationProps) {
  return (
    <nav aria-label={ariaLabel} className="flex items-center justify-between gap-3">
      <Button variant="secondary" size="sm" disabled={!hasPrevious} onClick={onPrevious}>
        {previousLabel}
      </Button>
      <Button variant="secondary" size="sm" disabled={!hasMore} onClick={onNext}>
        {nextLabel}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement ?? ''}
      </span>
    </nav>
  )
}
