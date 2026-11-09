// `list` (docs/specs/04-domain.md §4.1), its first slice: the addresses the
// organisation's applications answer at, read-only
// (docs/specs/domain-addresses-list.md). Two reads behind one query: the
// instance, then its addresses.
//
// What is NOT here is deliberate: no « Ajouter une adresse », no « Gérer », no
// row action, no record to copy, no check to run. Each arrives with the slice
// that makes it work — a control that does nothing is a defect, not a preview.
//
// This is the first panel of the area, not the area: `DomainScreen` holds the
// heading and, when the second tab exists, the tab strip.

import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { problemSuffix } from '../../api/problemSuffix'
import { orgRoute } from '../../app/org-route'
import { Badge } from '../../ui/Badge/Badge'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { DataTable } from '../../ui/DataTable/DataTable'
import type { DataTableColumn } from '../../ui/DataTable/DataTable'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { appLabelKey } from './apps'
import { STATE_PRESENTATION } from './domainStatus'
import { PURPOSE_LABEL_KEY } from './hosting'
import type { AddressRow } from './hosting'
import { useAddressesQuery } from './queries'

const NO_ROWS: AddressRow[] = []

function isForbidden(error: unknown): boolean {
  return (
    error instanceof ApiProblem && error.type !== null && problemSuffix(error.type) === 'forbidden'
  )
}

export function AddressList() {
  const { t } = useTranslation()
  // Read here, inside the gate: a person the gate turns away needs none of it.
  const { membership } = orgRoute.useLoaderData()
  const addressesQuery = useAddressesQuery(membership.organisation.id)
  const addresses = addressesQuery.data

  const columns: DataTableColumn<AddressRow>[] = [
    {
      key: 'address',
      rowHeader: true,
      header: t('console.domain.list.label-column-address'),
      render: (row) => (
        // COMPONENTS.md: "ellipsis on emails/hosts", and §4.1: "hostnames in
        // monospace, ellipsised". The whole name stays in the document for a
        // screen reader and in the title for a pointer.
        <span className="block max-w-[320px] truncate font-mono" title={row.host}>
          {row.host}
        </span>
      ),
    },
    {
      key: 'app',
      header: t('console.domain.list.label-column-app'),
      render: (row) => {
        const appKey = appLabelKey(row.app)
        const purposeKey = row.origin === 'organisation' ? PURPOSE_LABEL_KEY[row.purpose] : null
        return (
          <div className="flex flex-col">
            <span className="whitespace-nowrap">{appKey === null ? '—' : t(appKey)}</span>
            {purposeKey === null ? null : (
              <span className="text-xs whitespace-nowrap text-c-ink-3">{t(purposeKey)}</span>
            )}
          </div>
        )
      },
    },
    {
      key: 'state',
      header: t('console.domain.list.label-column-state'),
      status: true,
      render: (row) => {
        if (row.origin === 'provided') {
          // No pill: the API reports no state for an address it provides.
          return (
            <Badge className="whitespace-nowrap">{t('console.domain.list.badge-provided')}</Badge>
          )
        }
        const presentation = STATE_PRESENTATION[row.state]
        return (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state={presentation.pill}>{t(presentation.labelKey)}</StatusPill>
            {row.main ? (
              <Badge variant="accent" className="whitespace-nowrap">
                {t('console.domain.list.badge-primary')}
              </Badge>
            ) : null}
          </div>
        )
      },
    },
  ]

  // The Core API refused the read although the role `GET /me` reported let the
  // person in. Asking again would be refused again, so this names who can open
  // the page instead of offering a retry (docs/specs/README.md §2: "never a
  // raw 403").
  if (isForbidden(addressesQuery.error)) {
    return (
      <Banner
        kind="info"
        headline={t('console.shell.access.error-role', {
          owner: t('console.shell.access.label-owner-fallback'),
        })}
      />
    )
  }

  // Nothing to show and the read failed. A failed re-read of a list already on
  // screen leaves it there: what was loaded stays readable, offline included.
  if (addressesQuery.isError && addresses === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
        <Button variant="tertiary" size="sm" onClick={() => void addressesQuery.refetch()}>
          {t('console.common.action-retry')}
        </Button>
      </div>
    )
  }

  if (addresses !== undefined && !addresses.instance) {
    return (
      <EmptyState
        title={t('console.status.overview.title-no-tenant')}
        body={t('console.status.overview.empty-no-tenant')}
      />
    )
  }

  const rows = addresses === undefined ? NO_ROWS : addresses.rows
  const loading = addresses === undefined
  const noneOfItsOwn = !loading && !rows.some((row) => row.origin === 'organisation')

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {loading || rows.length > 0 ? (
        <DataTable
          caption={t('console.domain.list.label-tab-domains')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.key}
          // No row action in this slice, so no actions column is drawn and
          // this name is never rendered; the primitive requires one.
          actionsLabel={t('console.domain.list.action-manage')}
          loading={loading}
          loadingRowCount={3}
          loadingLabel={t('console.common.a11y-loading')}
        />
      ) : null}

      {noneOfItsOwn ? (
        <p className="text-sm text-c-ink-3">{t('console.domain.list.empty-body-none-yet')}</p>
      ) : null}
    </div>
  )
}
