// docs/specs/08-home.md §4.2: the applications table. §6.5's second and
// fourth contract gaps: no backup/restore-drill facts and no planned-app
// quarter exist in the contract, so the card's header carries no backup
// line and a planned app's row is never rendered — never "bientôt" with no
// quarter, which the design system forbids outright.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { components } from '../../api/schema'
import type { MessageKey } from '../../i18n'
import { Card, CardBody, CardHeader } from '../../ui/Card/Card'
import { Button } from '../../ui/Button/Button'
import { DataTable } from '../../ui/DataTable/DataTable'
import type { DataTableColumn } from '../../ui/DataTable/DataTable'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import type { StatusPillState } from '../../ui/StatusPill/StatusPill'
import { appStatusTone } from './format-helpers'
import { trackAppOpened, trackAppUrlCopied } from './analytics'
import type { HomeApp } from './analytics'

type TenantApp = components['schemas']['TenantApp']

const TONE_TO_PILL: Record<ReturnType<typeof appStatusTone>, StatusPillState> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  neutral: 'neutral',
}

const STATUS_KEY: Record<TenantApp['state'], MessageKey> = {
  live: 'console.home.overview.status-app-live',
  pending: 'console.home.overview.status-app-pending',
  degraded: 'console.home.overview.status-app-degraded',
  unavailable: 'console.home.overview.status-app-unavailable',
  maintenance: 'console.home.overview.status-app-maintenance',
}

export interface ApplicationsCardProps {
  apps: TenantApp[] | undefined
  onRetry?: () => void
  errored?: boolean
  agentStale?: boolean
}

export function ApplicationsCard({
  apps,
  errored = false,
  onRetry,
  agentStale = false,
}: ApplicationsCardProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<{ code: string; url: string } | undefined>(undefined)

  const [copyFailed, setCopyFailed] = useState(false)
  const request = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      request.current += 1
      window.clearTimeout(timer.current)
    },
    []
  )
  const copy = async (row: TenantApp) => {
    const current = ++request.current
    window.clearTimeout(timer.current)
    setCopied(undefined)
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(row.url)
      if (request.current !== current) return
      setCopied({ code: row.code, url: row.url })
      if (row.code === 'visio' || row.code === 'docs') trackAppUrlCopied(row.code)
      timer.current = window.setTimeout(() => setCopied(undefined), 1500)
    } catch {
      if (request.current === current) setCopyFailed(true)
    }
  }

  return (
    <Card>
      <CardHeader>
        <p className="text-sm font-medium text-c-ink">{t('console.home.overview.title-apps')}</p>
      </CardHeader>
      <CardBody className="flex flex-col gap-3 p-0">
        {copyFailed ? (
          <div className="px-5 pt-4">
            <InlineAlert kind="warning">{t('console.home.overview.error-copy-failed')}</InlineAlert>
          </div>
        ) : null}
        {agentStale ? (
          <div className="px-5 pt-4">
            <InlineAlert kind="warning">
              {t('console.status.overview.error-heartbeat-stale', { duration: '' })}
            </InlineAlert>
          </div>
        ) : null}
        {errored ? (
          <div className="px-5 pt-4 pb-4">
            <InlineAlert kind="error">
              {t('console.home.overview.error-summary-unavailable', { time: '' })}
            </InlineAlert>
            {onRetry ? <Button onClick={onRetry}>{t('console.common.action-retry')}</Button> : null}
          </div>
        ) : (
          <DataTable<TenantApp>
            caption={t('console.home.overview.a11y-apps-table')}
            actionsLabel={t('console.home.overview.a11y-app-actions')}
            loading={apps === undefined}
            loadingLabel={t('console.common.a11y-loading')}
            rows={apps ?? []}
            rowKey={(row) => row.code}
            empty={
              <span className="text-sm text-c-ink-3">{t('console.home.overview.empty-body')}</span>
            }
            columns={
              [
                {
                  key: 'name',
                  header: t('console.home.overview.label-app-column-name'),
                  render: (row) => <span className="font-medium text-c-ink">{row.name}</span>,
                },
                {
                  key: 'address',
                  header: t('console.home.overview.label-app-column-address'),
                  render: (row) => (
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-mono text-sm text-c-ink">
                        {row.url}
                      </span>
                      <Button
                        variant="tertiary"
                        size="sm"
                        aria-live="polite"
                        onClick={() => void copy(row)}
                      >
                        {copied?.code === row.code && copied.url === row.url
                          ? t('console.common.toast-copied')
                          : t('console.common.action-copy')}
                      </Button>
                      <span className="sr-only" role="status" aria-live="polite">
                        {copied?.code === row.code && copied.url === row.url
                          ? t('console.common.a11y-copied', { field: row.name })
                          : ''}
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'status',
                  header: t('console.home.overview.label-app-column-status'),
                  status: true,
                  render: (row) => (
                    <StatusPill state={TONE_TO_PILL[appStatusTone(row.state)]}>
                      {t(STATUS_KEY[row.state] ?? 'console.home.overview.status-app-unknown')}
                    </StatusPill>
                  ),
                },
              ] satisfies DataTableColumn<TenantApp>[]
            }
            rowActions={(row) => (
              <LinkButton
                href={row.url}
                target="_blank"
                variant="tertiary"
                size="sm"
                onClick={() => {
                  if (row.code === 'visio' || row.code === 'docs') {
                    trackAppOpened(row.code as HomeApp)
                  }
                }}
              >
                {t('console.home.overview.action-open-app', { app: row.name })}
              </LinkButton>
            )}
          />
        )}
      </CardBody>
    </Card>
  )
}
