// `/{org}/domain` — « Domaine & identité ». The area's frame: the role gate
// and the page heading, around the panel that lists the addresses
// (docs/specs/domain-addresses-list.md).
//
// The area has two tabs in the design of record: « Domaines », which is
// `AddressList`, and « Connexion (Google / Microsoft) », which is
// docs/specs/07-federation.md and is not built. The tab strip is therefore not
// drawn: a tab that leads to a placeholder is a control that does nothing.
// When the second tab exists, the strip, `?tab=` and the `/{org}/federation`
// redirect are added HERE, around the panel, which does not change.

import { useTranslation } from 'react-i18next'
import { RequireRole } from '../../app/RequireRole'
import { offers } from '../../app/capabilities'
import { AddressList } from './AddressList'
import { DOMAIN_MANAGER_ROLES } from './permissions'
import { PAGE_TITLE } from '../../ui/pageTitle'

function DomainArea() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Drawn in every state of the panel below — loading, failed, empty —
          so the page always says which page it is. */}
      <h1 className={PAGE_TITLE}>{t('console.shell.nav.title-domain')}</h1>

      {/* A plain box, not a named `section`: the table's own scroll box is
          already the region called « Domaines », and two landmarks of one name
          cannot be told apart. */}
      <div className="flex min-w-0 flex-col gap-4">
        {/* The panel's own heading, for a screen reader moving by headings and
            so a notice inside it does not skip a level. Not drawn: it is the
            word the tab will carry once there are two. */}
        <h2 className="sr-only">{t('console.domain.list.label-tab-domains')}</h2>
        {/* Core does not serve the address list yet (`src/app/capabilities.ts`): the page says
            so rather than draw a list that can only fail. */}
        {offers('domain-addresses') ? (
          <AddressList />
        ) : (
          <p className="text-sm text-c-ink-3">{t('console.common.body-area-pending')}</p>
        )}
      </div>
    </div>
  )
}

/**
 * The role gate is the one the placeholder had (`RequireRole`, the role
 * `GET /me` already returned): a member or a billing contact who types the URL
 * sees who may open the page, and no read is sent for them — the panel is not
 * mounted at all.
 *
 * No `key` on the panel: it holds no state of its own that a change of
 * organisation could leave stale — the query is keyed by the organisation.
 */
export function DomainScreen() {
  return (
    <RequireRole allow={DOMAIN_MANAGER_ROLES} titleKey="console.shell.nav.title-domain">
      <DomainArea />
    </RequireRole>
  )
}
