// The name of the application an address serves, as the list shows it
// (docs/specs/domain-addresses-list.md). The contract carries a code; the
// customer reads the name the Applications screen already uses for it.
//
// Exhaustive on purpose: an application the contract adds at a repin is a
// compile error here. `null` is an application the catalogue has no name for
// yet — the list draws a dash for it, never the raw code.

import type { components } from '../../api/schema'
import type { MessageKey } from '../../i18n'

export type AppCode = components['schemas']['AppCode']

const APP_LABEL_KEY: Record<AppCode, MessageKey | null> = {
  visio: 'console.status.overview.label-app-visio',
  docs: 'console.status.overview.label-app-docs',
  drive: null,
  messaging: null,
  grist: null,
}

export function isAppCode(value: unknown): value is AppCode {
  return typeof value === 'string' && Object.hasOwn(APP_LABEL_KEY, value)
}

/** The catalogue key of the application's name, or `null` when there is no
 * application, or none the catalogue names. */
export function appLabelKey(app: string | null | undefined): MessageKey | null {
  return isAppCode(app) ? APP_LABEL_KEY[app] : null
}
