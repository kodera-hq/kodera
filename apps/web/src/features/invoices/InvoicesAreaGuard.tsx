// Role gate every screen in this area opens with (§5's "Permission denied"
// row: "the action is not rendered at all, and a direct URL shows a `Banner`
// naming who can do it"). Reads the role `orgRoute`'s loader already fetched
// from `GET /me` — no Core API call of its own, and no route redirect: the
// URL stays where the person typed or clicked it, same as `NotFoundOrganisation`.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { orgRoute } from '../../app/org-route'
import { Banner } from '../../ui/Banner/Banner'
import { canViewInvoices } from './permissions'
import { PAGE_TITLE } from '../../ui/pageTitle'

export function InvoicesAreaGuard({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { membership } = orgRoute.useLoaderData()

  if (!canViewInvoices(membership.role)) {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <h1 className={PAGE_TITLE}>{t('console.invoices.list.title')}</h1>
        <Banner kind="info" headline={t('console.invoices._.error-role-generic')} />
      </div>
    )
  }

  return <>{children}</>
}
