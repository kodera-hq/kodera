import type { MessageKey } from '../i18n'
import type { UserBlockUser } from './UserBlock'

/**
 * The account menu's entries (docs/specs/00-shell-and-login.md §4.5), listed
 * once for both layouts: the wide layout's `UserBlock` menu draws every entry
 * whose `wide` is true; the narrow layout puts each entry where `narrow` says —
 * a place in the « Plus » sheet, an action in the top menu, or nowhere. A new
 * entry is added here and reaches both layouts, as « Apparence » (the theme
 * choice) did, and TypeScript refuses an entry that says nothing about the
 * narrow layout.
 */
interface AccountItemBase {
  id: string
  labelKey: MessageKey
  /** Drawn in the wide layout's account menu. */
  wide: boolean
}

/** A page of its own, under the organisation, like the sidebar's areas. On a
 * phone it goes to the « Plus » sheet with the other places, or to the top
 * menu, or nowhere. */
export interface AccountPlace extends AccountItemBase {
  kind: 'place'
  to: '/$org/security' | '/$org/appearance'
  narrow: 'more' | 'account-menu' | 'none'
}

/** No screen yet: the wide menu lists it and it does nothing when chosen. */
export interface AccountPending extends AccountItemBase {
  kind: 'pending'
  narrow: 'account-menu' | 'none'
}

export interface AccountSignOut extends AccountItemBase {
  kind: 'sign-out'
  narrow: 'account-menu' | 'none'
}

/**
 * Every layout decides what an entry DOES from its `kind`, never from where it
 * is drawn: `UserBlock` and `NarrowTopBar` both switch on it, so an entry moved
 * into the top menu cannot inherit sign-out from its neighbour. Only a place
 * can go to « Plus », which is a list of places.
 */
export type AccountItem = AccountPlace | AccountPending | AccountSignOut

export const ACCOUNT_ITEMS: readonly AccountItem[] = [
  {
    id: 'security',
    kind: 'place',
    labelKey: 'console.shell.account.action-security',
    to: '/$org/security',
    wide: true,
    narrow: 'more',
  },
  // The theme choice (docs/specs/10-appearance.md). On a phone it sits in
  // « Plus » beside « Sécurité et connexion » (owner ruling, 2026-09-24).
  {
    id: 'appearance',
    kind: 'place',
    labelKey: 'console.shell.account.action-appearance',
    to: '/$org/appearance',
    wide: true,
    narrow: 'more',
  },
  // Left out of the narrow layout (owner-approved deviation, 2026-09-24)
  // rather than drawn as a control that does nothing on a phone.
  {
    id: 'language',
    kind: 'pending',
    labelKey: 'console.shell.account.action-language',
    wide: true,
    narrow: 'none',
  },
  {
    id: 'sign-out',
    kind: 'sign-out',
    labelKey: 'console.shell.account.action-sign-out',
    wide: true,
    narrow: 'account-menu',
  },
]

/** The role under the person's name, in the customer's words, in both layouts. */
export function accountRoleLabelKey(user: UserBlockUser): MessageKey {
  return user.role === 'org_admin'
    ? 'console.shell.account.status-role-admin'
    : 'console.shell.account.status-role-member'
}
