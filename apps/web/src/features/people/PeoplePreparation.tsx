import { useTranslation } from 'react-i18next'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import type { OrganisationRole } from './roles'
import { offers } from '../../app/capabilities'

export interface PeoplePreparationProps {
  org: string
  role: OrganisationRole | 'member'
  source: 'order' | 'status'
}

/** Preparation uses the existing import route, without granting order access. */
export function PeoplePreparation({ org, role, source }: PeoplePreparationProps) {
  const { t } = useTranslation()
  if (role !== 'org_owner' && role !== 'org_admin') return null
  // It leads to the CSV import, hidden while Core does not serve it (`src/app/capabilities.ts`).
  if (!offers('member-import')) return null

  return (
    <div className="flex flex-col items-start gap-3">
      <h2 className="text-md font-semibold text-c-ink">
        {t('console.order.confirmation.title-next-steps')}
      </h2>
      <LinkButton
        href={`/${org}/people/import?from=${source}`}
        variant="secondary"
        className="h-auto min-h-10 max-w-full py-2 text-left whitespace-normal"
      >
        {t('console.order.confirmation.action-prepare-people')}
      </LinkButton>
    </div>
  )
}
