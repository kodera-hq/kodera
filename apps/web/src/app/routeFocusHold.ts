// Route changes that should leave focus where it is (docs/specs/11-workspace.md, « Keyboard
// shortcuts »): `Alt` and the arrows change the workspace's channel, which is a new address, and
// the member who pressed them keeps writing. The view names the path before it navigates;
// `RouteFocus` then neither moves focus nor announces that change, since the view says it.
//
// Read during rendering, never changed there, so a render React draws twice reads the same. Each
// path is let go on its own: by `RouteFocus` once that path has settled, and by the view once its
// navigation is over, so a path that never came (superseded, refused) holds nothing afterwards.
// The view's release waits a task after `navigate()` resolves, which TanStack Router does only
// once the new location is resolved and drawn; check that order again on a router upgrade.

const held = new Set<string>()

/** A route change to `pathname` keeps focus and says nothing. */
export function keepFocusOnRouteTo(pathname: string): void {
  held.add(pathname)
}

/** Whether a change to `pathname` is one asked to keep focus. */
export function keepsFocus(pathname: string): boolean {
  return held.has(pathname)
}

/** `pathname` has settled, or its navigation is over: its hold is let go. */
export function releaseRouteFocus(pathname: string): void {
  held.delete(pathname)
}
