// View-only string logic that is not itself a formatting rule
// (`src/i18n/format.ts` stays the one place that divides) but is not a
// message-catalogue lookup either — kept pure and here so it can be tested
// without mounting a component.

import type { components } from '../../api/schema'
import type { MessageKey } from '../../i18n'

type Me = components['schemas']['Me']
type TenantApp = components['schemas']['TenantApp']

/**
 * "Bonjour Claire", not "Bonjour Claire Dubois" (08-home.md §4.2's own
 * wireframe). `display_name` is the person's own free-text name; this takes
 * its first word. Falls back to the local part of the email when there is
 * no display name at all, which is the only other identifier `/me` carries.
 */
export function firstNameOf(me: Pick<Me, 'display_name' | 'email'>): string {
  const source = me.display_name?.trim()
  if (source !== undefined && source.length > 0) {
    return source.split(/\s+/)[0] ?? source
  }
  return me.email.split('@')[0] ?? me.email
}

export type AppStatusTone = 'success' | 'warning' | 'danger' | 'neutral'

/**
 * §8's validation rule for the whole screen: "An unknown … `apps[].state` is
 * rendered with the neutral pill and the 'État inconnu' label, never as
 * operational." `pending` reads as neutral too — an app mid-install is not a
 * problem, but it is not "En ligne" either.
 */
export function appStatusTone(state: TenantApp['state']): AppStatusTone {
  switch (state) {
    case 'live':
      return 'success'
    case 'degraded':
      return 'warning'
    case 'unavailable':
      return 'danger'
    case 'maintenance':
    case 'pending':
      return 'neutral'
    default:
      return 'neutral'
  }
}

export type BillingPeriod = components['schemas']['BillingPeriod']

/** The {cycle} placeholder of `console.home.overview.hint-next-invoice` — the
 * catalogue key for the word, chosen from the API's own closed enum. */
export function billingPeriodKey(period: BillingPeriod): MessageKey {
  return period === 'yearly'
    ? 'console.home.overview.label-billing-period-yearly'
    : 'console.home.overview.label-billing-period-monthly'
}
