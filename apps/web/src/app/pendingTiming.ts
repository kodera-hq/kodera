// When a route that is still loading paints its pending screen, and for how long at least.
//
// Under `ORGANISATION_PENDING_MS` a transition — a lazy area's file, the organisation layout's
// `GET /me` — paints nothing in between: the page being left stays until the next one is ready.
// A slower one paints the pending screen and keeps it for `ORGANISATION_PENDING_MIN_MS`, so it is
// read as a loading state and not as a blink of the whole screen.

export const ORGANISATION_PENDING_MS = 180
export const ORGANISATION_PENDING_MIN_MS = 250
