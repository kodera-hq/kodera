// What the page on screen is, while a navigation waits on a route unit that is being fetched
// (`./lazyRouteTree.ts`).
//
// The router changes its location the moment a navigation starts, and the layout reads its title
// and its surface from that location. While the next page only waits on its own loader that is a
// matter of milliseconds. The first visit to an area also waits for the area's file, and for that
// long the header would name the new area above the page still being left: a person, or a test,
// who reads the title as "the page has changed" acts on the old page, and the new one then takes
// focus back as it arrives (`./RouteFocus.tsx`). So for the length of such a wait the layout keeps
// describing the page that is on screen, and its title changes with the content, in one commit.
//
// One wait at a time is all there can be — a router has one navigation in flight — but two
// navigations can overlap for a moment, hence a count. Every wait ends when the router next
// settles on a page, whichever navigation got there, and at once when a fetch fails.

import { useRouterState } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'

let waits = 0
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const waiting = (): boolean => waits > 0

/** A navigation has started fetching a route unit it cannot go on without. */
export function beginLazyRouteWait(): void {
  waits += 1
  if (waits === 1) changed()
}

/** The router has settled on a page, or the fetch failed: nothing is being waited on. */
export function endLazyRouteWaits(): void {
  if (waits === 0) return
  waits = 0
  changed()
}

/**
 * The path of the page a person is looking at: the router's location, except while a navigation
 * waits on a route unit, when it is still the path the router last settled on.
 */
export function useShownPathname(): string {
  const held = useSyncExternalStore(subscribe, waiting, waiting)
  return useRouterState({
    select: (state) =>
      held
        ? (state.resolvedLocation?.pathname ?? state.location.pathname)
        : state.location.pathname,
  })
}
