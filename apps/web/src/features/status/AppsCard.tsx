// "Vos applications" (docs/specs/02-status.md §4.2): the biggest thing on a
// live screen, because sharing an address is the first thing the buyer
// does. Every app shows both its primary address and the `kodera.io`
// fallback — never removable, never hidden (§4.2's own rule) — each with its
// own copy control.

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { trackAppOpened } from './analytics'
import type { components } from '@/api/schema'
import { Card, CardBody } from '@/ui/Card/Card'
import { CopyableField } from '@/ui/CopyableField/CopyableField'
import type { CopyStatus } from '@/ui/CopyableField/CopyableField'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { useToast } from '@/ui/Toast/Toast'
import { StatusPill, type StatusPillState } from '@/ui/StatusPill/StatusPill'
import { ModuleGlyph } from '@/ui/icons/ModuleGlyph'
import { moduleGlyphName } from '@/app/railModules'
import type { MessageKey } from '@/i18n'

export type TenantApp = components['schemas']['TenantApp']

const TRACKED_APP_CODES = new Set(['visio', 'docs'])

function isTrackedAppCode(code: string): code is 'visio' | 'docs' {
  return TRACKED_APP_CODES.has(code)
}

function AppAddressRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()
  const notify = useToast()
  const [status, setStatus] = useState<CopyStatus>('idle')
  const generation = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      generation.current += 1
      window.clearTimeout(timer.current)
    },
    []
  )

  const handleCopy = () => {
    const current = ++generation.current
    window.clearTimeout(timer.current)
    setStatus('idle')
    void (async () => {
      try {
        await navigator.clipboard.writeText(value)
        if (generation.current !== current) return
        setStatus('copied')
        notify({ kind: 'success', title: t('console.common.a11y-copied', { field: label }) })
        timer.current = window.setTimeout(() => setStatus('idle'), 1500)
      } catch {
        // The Clipboard API can be unavailable (permissions, insecure
        // context); the value is still visible, selectable text in the
        // field itself (`CopyableField`'s own contract), so nothing here
        // leaves the person with no way to get the address.
      }
    })()
  }

  return (
    <CopyableField
      layout="stacked"
      label={label}
      value={value}
      status={status}
      copyLabel={t('console.common.action-copy')}
      copiedLabel={t('console.common.toast-copied')}
      onCopy={handleCopy}
    />
  )
}

const APP_STATE: Record<TenantApp['state'], { tone: StatusPillState; label: MessageKey }> = {
  pending: { tone: 'neutral', label: 'console.status.app.status-pending' },
  live: { tone: 'success', label: 'console.status.app.status-live' },
  degraded: { tone: 'warning', label: 'console.status.app.status-degraded' },
  unavailable: { tone: 'danger', label: 'console.status.app.status-unavailable' },
  maintenance: { tone: 'info', label: 'console.status.app.status-maintenance' },
}

function AppCard({ app }: { app: TenantApp }) {
  const { t } = useTranslation()
  const titleId = useId()
  const health =
    typeof app.state === 'string' && Object.hasOwn(APP_STATE, app.state)
      ? APP_STATE[app.state]
      : { tone: 'neutral' as const, label: 'console.status.app.status-unknown' as const }

  const handleOpen = () => {
    if (isTrackedAppCode(app.code)) trackAppOpened(app.code)
  }

  return (
    <section aria-labelledby={titleId}>
      <Card>
        <CardBody className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="shrink-0 text-c-ink">
              <ModuleGlyph name={moduleGlyphName(app.code)} />
            </span>
            <h3 id={titleId} className="text-lg font-semibold text-c-ink">
              {app.name}
            </h3>
            {app.version ? (
              <span className="font-mono text-xs text-c-ink-3">
                {t('console.status.app.label-version', { version: app.version })}
              </span>
            ) : null}
            <StatusPill state={health.tone}>{t(health.label)}</StatusPill>
            <LinkButton
              className="ml-auto"
              href={app.url}
              target="_blank"
              size="sm"
              variant="secondary"
              onClick={handleOpen}
              aria-label={`${t('console.status.overview.action-open-app', { app: app.name })} — ${t('console.common.a11y-opens-new-tab')}`}
            >
              {t('console.status.overview.action-open-app', { app: app.name })} ↗
            </LinkButton>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
            <AppAddressRow key={`primary:${app.url}`} label={app.name} value={app.url} />
            {app.default_url === undefined ? null : (
              <AppAddressRow
                key={`fallback:${app.default_url}`}
                label={`${app.name} · ${t('console.status.overview.label-app-fallback')}`}
                value={app.default_url}
              />
            )}
          </div>
        </CardBody>
      </Card>
    </section>
  )
}

export interface AppsCardProps {
  apps: readonly TenantApp[]
}

export function AppsCard({ apps }: AppsCardProps) {
  const { t } = useTranslation()
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <h2 id={titleId} className="text-md font-semibold text-c-ink">
        {t('console.status.overview.title-apps')}
      </h2>
      {apps.map((app) => (
        <AppCard key={app.code} app={app} />
      ))}
    </section>
  )
}
