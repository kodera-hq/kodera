// The one place a screen reports a product event (§11 of every screen
// specification). It has no vendor and no destination: `track()` builds an
// event and hands it to whatever listeners are registered, and that is all.
// Nothing here opens a network connection, writes to storage, or queues for a
// later flush — `track.test.ts` asserts each of those rather than trusting the
// absence of an import.
//
// Two rules shape the split between this file and `src/features/<area>/
// analytics.ts`:
//
//   1. `name` is a plain string here, not a union of every event the console
//      will ever emit. A shared union would make this file the one file every
//      area's author edits, which is the registry conflict that
//      `src/mocks/overlays` avoids by globbing. Each area declares its own
//      events in its own `analytics.ts` and exposes named functions, so a
//      typo is still a compile error at the call site — the type lives one
//      layer up, not in a file everyone shares.
//   2. No personal data reaches a property, ever: no email address, no
//      display name, no organisation name, no custom domain, no slug. Every
//      property an area declares is a count, a bucket or a closed enum. The
//      per-area signatures are what enforce it; `TrackPropertyValue` only
//      stops an object graph being passed in wholesale.
//
// A listener that throws is left to throw. The only listeners today are in
// tests, and swallowing there would hide the bug the test exists to catch.
// Isolating a failing sink is a question for whenever a real one lands, and
// it belongs with that sink.

export type TrackPropertyValue = string | number | boolean
export type TrackProperties = Record<string, TrackPropertyValue>

export interface AnalyticsEvent {
  name: string
  properties: TrackProperties
}

export type AnalyticsListener = (event: AnalyticsEvent) => void

const listeners = new Set<AnalyticsListener>()

/**
 * Records one product event and hands it to every registered listener.
 * Returns nothing, so no caller can start depending on a delivery result
 * that a real sink would not be able to promise anyway.
 */
export function track<Properties extends TrackProperties>(
  name: string,
  properties: Properties
): void {
  const event: AnalyticsEvent = { name, properties }
  // A snapshot, so a listener that unsubscribes itself while it is being
  // called does not change the set mid-iteration.
  for (const listener of [...listeners]) listener(event)
}

/**
 * Subscribes to every event `track()` records, and returns the function that
 * unsubscribes it — the shape `AuthAdapter.onExpiring` already uses. Test-only
 * in practice: no screen needs to observe its own analytics.
 */
export function onTrack(listener: AnalyticsListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
