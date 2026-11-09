// The one way the console writes a link to the Aide page (`/{org}/help`).
// Every support action builds its target here — through `helpHref` for an
// imperative navigation, or `<HelpLink>` (`./HelpLink.tsx`) for a router
// link — with its context typed as `HelpSearch`, so a misspelt topic is a type
// error rather than a subject the page silently drops.
// `help-links.test.ts` counts the calls, file by file.

import { helpSearchSchema } from './helpTopic'
import type { HelpSearch } from './helpTopic'

/** The query-string order is the schema's own key order, fixed, so the same
 * context is always the same URL and a key added to the schema is written. */
const ORDER = Object.keys(helpSearchSchema.shape) as (keyof HelpSearch)[]

export function helpSearchParams(search: HelpSearch): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of ORDER) {
    const value = search[key]
    if (value !== undefined) params.set(key, value)
  }
  return params
}

export function helpHref(org: string, search: HelpSearch = {}): string {
  const query = helpSearchParams(search).toString()
  return query === '' ? `/${org}/help` : `/${org}/help?${query}`
}
