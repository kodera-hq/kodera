import { useSyncExternalStore } from 'react'
import { NARROW_LAYOUT_QUERY } from './layoutQuery'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(NARROW_LAYOUT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** A browser without `matchMedia` — jsdom, which every unit test runs in —
 * gets the wide layout, the one the whole unit suite was written against. */
function isNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(NARROW_LAYOUT_QUERY).matches
}

/**
 * Whether the shell draws its narrow layout (`layoutQuery.ts` says when). The
 * shell picks one of its two frames in script rather than rendering both and
 * hiding one in CSS: the two carry their own navigation landmarks and their own
 * copies of every link, and a hidden duplicate is still in a DOM a test or an
 * extension reads.
 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, () => false)
}
