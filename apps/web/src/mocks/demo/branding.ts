// The demo seed's own branding, and the only writer of
// `src/app/demoBranding.ts`'s registry.
//
// Groupe Vercelli is FICTIONAL — the demo organisation of the design handoff,
// not a customer. Its mark lives beside this file, in the mock tree, and never
// in `public/`: `public/` is the maker's brand set, copied verbatim to the
// bundle root of every build, and a customer's mark shipped there would be a
// product asset rather than a fixture.
//
// `?raw` rather than a plain asset import, deliberately, and rather than
// `?inline` either.
//
// A PLAIN import makes Vite emit a real file into `dist/assets/`, and an
// emitted asset does not disappear just because the module that referenced it
// was tree-shaken — the demo mark would ship in a production build as a
// fetchable URL. Both `?raw` and `?inline` avoid that by putting the mark in
// this module as a string, so it lives or dies with the module, and the module
// dies with the mock tree.
//
// Between those two, `?raw` — because `?inline` base64-encodes, and a mark
// that ships as base64 is a mark no grep can find. The bundle check
// (`scripts/check-production-bundle.sh`) proves the demo asset is absent by
// looking for `Vercelli` in the emitted JavaScript; against a base64 payload
// that search passes on a build that is carrying the mark, which is a check
// that cannot fail. `?raw` keeps the SVG text verbatim, so the same grep has
// something real to find in a mock build and something real to miss in a
// production one.
//
// This is a stand-in for a Core contract field that does not exist. See
// `src/app/demoBranding.ts` for the field list that is missing it.

import { registerDemoOrganisationMark } from '@/app/demoBranding'
import vercelliMark from './brand/vercelli-mark.svg?raw'

/** The demo organisation the `shell.demo-branding` overlay serves. */
export const DEMO_BRANDED_ORGANISATION_SLUG = 'vercelli'

/** The mark as an `<img src>` value. `encodeURIComponent` rather than base64
 * for the reason above, and because an SVG data URI carrying a raw `#` (the
 * mark's own fill) truncates at that character in some browsers. */
export function demoMarkDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function installDemoBranding(): void {
  registerDemoOrganisationMark(DEMO_BRANDED_ORGANISATION_SLUG, demoMarkDataUri(vercelliMark))
}
