// Home offers the existing People invitation route to organisation managers.

import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import { formatWeekdayDate } from '../../i18n/format'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import type { OrganisationRole } from '../people/roles'
import { PAGE_TITLE } from '../../ui/pageTitle'

export type OverallHealth = 'operational' | 'incident' | 'maintenance'

export interface GreetingHeaderProps {
  org: string
  role: OrganisationRole
  firstName: string
  now: string
  health: OverallHealth
}

const SUBTITLE_KEY: Record<OverallHealth, MessageKey> = {
  operational: 'console.home.overview.subtitle',
  incident: 'console.home.overview.subtitle-incident',
  maintenance: 'console.home.overview.subtitle-maintenance',
}

export function GreetingHeader({ org, role, firstName, now, health }: GreetingHeaderProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'

  return (
    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
      <div>
        <h1 className={PAGE_TITLE}>{t('console.home.overview.title', { firstName })}</h1>
        <p role="status" className="mt-1 text-md text-c-ink-3">
          {t(SUBTITLE_KEY[health], { date: formatWeekdayDate(now, locale) })}
        </p>
      </div>
      {role === 'org_owner' || role === 'org_admin' ? (
        <LinkButton href={`/${org}/people/invite`}>
          {t('console.home.overview.action-invite')}
        </LinkButton>
      ) : null}
    </div>
  )
}
