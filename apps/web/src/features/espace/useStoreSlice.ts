// A part of the live view reads one slice of a store, and is drawn again only when that slice
// changes. The store's snapshot is the token (`matrix/store.ts`: « getSnapshot is also the
// subscription token for the timeline and thread getters »): the slice is read once per snapshot,
// and a slice equal to the last one keeps the last one's identity, so a store that publishes for
// another part of the screen draws nothing here.

import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'

/**
 * Reads the slice once per snapshot. A slice equal to the last one is the last one, so a reader
 * that compares identities (`useSyncExternalStore`, `memo`) sees no change.
 */
function sliceReader<Snapshot, Slice>(
  getSnapshot: () => Snapshot,
  select: (snapshot: Snapshot) => Slice,
  isEqual: (previous: Slice, next: Slice) => boolean
): () => Slice {
  let cached: { token: Snapshot; slice: Slice } | null = null
  return () => {
    const token = getSnapshot()
    if (cached !== null && Object.is(cached.token, token)) return cached.slice
    const next = select(token)
    const slice = cached !== null && isEqual(cached.slice, next) ? cached.slice : next
    cached = { token, slice }
    return slice
  }
}

/**
 * `select` reads the slice from the snapshot (and from the store's own getters, which change with
 * it). Give it a stable identity (`useCallback`, or a function of the module): a new one is a new
 * slice to read. `isEqual` says when two reads are the same slice; identity by default.
 */
export function useStoreSlice<Snapshot, Slice>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => Snapshot,
  select: (snapshot: Snapshot) => Slice,
  isEqual: (previous: Slice, next: Slice) => boolean = Object.is
): Slice {
  const read = useMemo(
    () => sliceReader(getSnapshot, select, isEqual),
    [getSnapshot, select, isEqual]
  )
  return useSyncExternalStore(subscribe, read)
}

/**
 * A handler whose identity never changes and which always runs the latest one given: a memoised
 * part can hold it without being drawn again each time its owner is, and a click still acts on
 * what the owner last drew. For events only: it is not to be called while rendering.
 */
export function useStableHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}
