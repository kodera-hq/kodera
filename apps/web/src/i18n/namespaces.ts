// The namespaces of the message catalogue, and the ones the application carries with it.
//
// A key's namespace is its `<area>` segment: `console.people.list.title` belongs to `people`.
// `npm run i18n:generate` writes one catalogue per namespace and locale under `./catalogues/`,
// and the runtime (`./index.ts`) loads a namespace the first time a route that needs it is
// reached (`src/app/routeTree.ts`). Call sites do not change: `t('console.people.list.title')`
// reads the same key whichever file delivered it.
//
// This file imports nothing, so the checks under `scripts/i18n/` can read it as it is.

/** Every namespace `docs/specs/copy/{fr,en}.md` defines. `npm run i18n:check` refuses a drift. */
export const MESSAGE_NAMESPACES = [
  'appearance',
  'claim',
  'common',
  'docs',
  'domain',
  'entry',
  'federation',
  'home',
  'invitation',
  'invoices',
  'login',
  'messaging',
  'mockidp',
  'onboarding',
  'order',
  'people',
  'shell',
  'status',
  'support',
  'workspace',
] as const

export type MessageNamespace = (typeof MESSAGE_NAMESPACES)[number]

/**
 * What every page may render before any route has been asked for anything: the shared words, the
 * session and error screens of the shell, the sign-in screens and an invitation's acceptance.
 * The default language's copy of these is part of the application bundle; nothing else is.
 *
 * `entry` is not here: its four sentences are written into `index.html` at build time
 * (`vite.config.ts`) and no running code reads them.
 */
export const ENTRY_NAMESPACES = [
  'common',
  'invitation',
  'login',
  'shell',
] as const satisfies readonly MessageNamespace[]

/**
 * What the organisation layout reads, whichever area is on screen: the shell's banner (`status`),
 * its help links (`support`), the workspace's settings and menus, the order flow's titles, the
 * extension catalogue (`onboarding`) and the theme editor (`appearance`). The layout's route unit
 * names them (`src/app/routeTree.ts`), and a build delivers them as one file per locale rather
 * than six (`vite.config.ts`).
 */
export const ORGANISATION_NAMESPACES = [
  'appearance',
  'onboarding',
  'order',
  'status',
  'support',
  'workspace',
] as const satisfies readonly MessageNamespace[]

/** The namespace a catalogue key belongs to, or `undefined` for a string that is not one. */
export function namespaceOfKey(key: string): MessageNamespace | undefined {
  const segment = /^console\.([a-z]+)\./.exec(key)?.[1]
  return MESSAGE_NAMESPACES.find((namespace) => namespace === segment)
}
