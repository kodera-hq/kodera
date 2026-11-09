import { useTranslation } from 'react-i18next'
import { Avatar } from '../ui/Avatar/Avatar'
import { DropdownMenu } from '../ui/DropdownMenu/DropdownMenu'
import type { DropdownMenuEntry } from '../ui/DropdownMenu/DropdownMenu'
import { ACCOUNT_ITEMS, accountRoleLabelKey } from './accountItems'
import type { AccountItem } from './accountItems'

export type UserRole = 'org_admin' | 'member'

export interface UserBlockUser {
  readonly displayName: string
  readonly role: UserRole
}

export interface UserBlockProps {
  user: UserBlockUser
  onSignOut: () => void
  /** Opens an account place (« Sécurité et connexion », « Apparence ») — the caller owns the
   * router. Omitted, the place's entry does nothing, as in a unit test. */
  onOpenPlace?: (to: Extract<AccountItem, { kind: 'place' }>['to']) => void
}

/**
 * The account menu pinned to the bottom of the sidebar (docs/specs/
 * 00-shell-and-login.md §4.5): avatar initials, display name, role in the
 * customer's own words, opening the account entries of `accountItems.ts` — the
 * list the narrow layout draws from too. « Sécurité et connexion » opens its
 * placeholder page; « Apparence » opens the theme choice; « Langue » has no
 * screen yet; « Se déconnecter » signs out.
 */
export function UserBlock({ user, onSignOut, onOpenPlace }: UserBlockProps) {
  const { t } = useTranslation()
  const roleLabel = t(accountRoleLabelKey(user))
  const items: DropdownMenuEntry[] = ACCOUNT_ITEMS.filter((item) => item.wide).flatMap(
    (item): DropdownMenuEntry[] => {
      const label = t(item.labelKey)
      switch (item.kind) {
        case 'place':
          return [{ label, onSelect: () => onOpenPlace?.(item.to) }]
        case 'pending':
          return [{ label, onSelect: () => {} }]
        case 'sign-out':
          return [{ type: 'separator' }, { label, onSelect: onSignOut }]
      }
    }
  )

  return (
    <div className="border-t border-c-border-soft p-3">
      <DropdownMenu
        trigger={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-c-surface focus-visible:ring focus-visible:outline-hidden"
          >
            <Avatar
              name={user.displayName}
              variant={user.role === 'org_admin' ? 'admin' : 'member'}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-c-ink">
                {user.displayName}
              </span>
              <span className="block truncate text-xs text-c-ink-3">{roleLabel}</span>
            </span>
          </button>
        }
        label={t('console.shell.account.title')}
        align="start"
        items={items}
      />
    </div>
  )
}
