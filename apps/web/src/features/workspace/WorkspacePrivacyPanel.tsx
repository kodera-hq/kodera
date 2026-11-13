// Self-service GDPR Art. 20 data portability & Art. 17 account/workspace erasure panel.
// Zero inline `[style]` attributes (`style-src-attr 'none'`). Surfaces async checkpoint
// states (`queued`, `running`, `ready`, `held` / 503 unavailable proof, `expired`,
// `retention_pending`), time-bounded signed archive downloads, explicit slug re-entry
// confirmation, and statutory `Code de commerce L123-22` retention disclosure.

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrganisationRole } from '../../app/Sidebar'
import { ApiProblem } from '../../api/client'
import { formatDate } from '../../i18n/format'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { StatusPill, type StatusPillState } from '../../ui/StatusPill/StatusPill'
import { TextField } from '../../ui/TextField/TextField'
import { resolveBillingLocale } from '../billing/billingMessages'
import {
  getAccountDeletion,
  getAccountExport,
  getAccountExportDownloadLink,
  getWorkspaceDeletion,
  getWorkspaceExport,
  getWorkspaceExportDownloadLink,
  requestAccountDeletion,
  requestAccountExport,
  requestWorkspaceDeletion,
  requestWorkspaceExport,
  type AnyPrivacyDeletion,
  type AnyPrivacyExport,
  type PrivacyDeletionStatus,
  type PrivacyExportStatus,
} from './privacyApi'
import { privacyCopy } from './privacyMessages'

const EXPORT_PILL: Record<PrivacyExportStatus, StatusPillState> = {
  queued: 'info',
  running: 'info',
  ready: 'success',
  failed: 'warning',
  expired: 'neutral',
  cancelled: 'neutral',
}

const DELETION_PILL: Record<PrivacyDeletionStatus, StatusPillState> = {
  queued: 'info',
  running: 'warning',
  retention_pending: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

export interface WorkspacePrivacyPanelProps {
  org: string
  organisationId: string
  role: OrganisationRole
  initialAccountExport?: AnyPrivacyExport | null | undefined
  initialWorkspaceExport?: AnyPrivacyExport | null | undefined
  initialAccountDeletion?: AnyPrivacyDeletion | null | undefined
  initialWorkspaceDeletion?: AnyPrivacyDeletion | null | undefined
}

function classifyPrivacyError(
  error: unknown,
  copy: ReturnType<typeof privacyCopy>
): { hold503: boolean; message: string } {
  if (error instanceof ApiProblem) {
    if (error.status === 503) {
      return { hold503: true, message: copy.proofUnavailableHoldBanner }
    }
    if (error.status === 409) {
      return { hold503: false, message: copy.conflictLastOwnerError }
    }
    if (error.status === 401 || error.status === 403) {
      return { hold503: false, message: copy.reauthRequiredError }
    }
  }
  return { hold503: false, message: copy.genericActionError }
}

function ExportStatusBlock({
  job,
  nowMs,
  locale,
  copy,
  refreshing,
  downloading,
  onRefresh,
  onDownload,
}: {
  job: AnyPrivacyExport
  nowMs: number
  locale: 'fr' | 'en'
  copy: ReturnType<typeof privacyCopy>
  refreshing: boolean
  downloading: boolean
  onRefresh: () => void
  onDownload: () => void
}) {
  const isExpiredByClock =
    job.expiresAt !== null && Number.isFinite(Date.parse(job.expiresAt))
      ? Date.parse(job.expiresAt) <= nowMs
      : false
  const canDownload = job.status === 'ready' && !isExpiredByClock

  return (
    <div className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-sunken p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-c-ink-3">
          {copy.requestIdLabel}: {job.id}
        </span>
        <StatusPill state={EXPORT_PILL[job.status]}>
          {copy.exportStatuses[job.status]}
        </StatusPill>
      </div>

      <DefinitionList
        items={[
          {
            term: copy.requestedAtLabel,
            description: formatDate(job.requestedAt, locale),
          },
          {
            term: copy.updatedAtLabel,
            description: formatDate(job.updatedAt, locale),
          },
          ...(job.expiresAt
            ? [
                {
                  term: copy.expiresAtLabel,
                  description: formatDate(job.expiresAt, locale),
                },
              ]
            : []),
        ]}
      />

      {job.failureCode !== null ? (
        <InlineAlert
          kind={
            job.failureCode === 'legal_hold' || job.failureCode === 'storage_unavailable'
              ? 'warning'
              : 'error'
          }
        >
          {copy.failureReasons[job.failureCode]}
        </InlineAlert>
      ) : null}

      {job.status === 'expired' || (job.status === 'ready' && isExpiredByClock) ? (
        <p className="text-xs text-c-warn-ink">{copy.downloadExpiredNotice}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {canDownload ? (
          <Button variant="primary" size="sm" loading={downloading} onClick={onDownload}>
            {copy.downloadExportAction}
          </Button>
        ) : null}
        {job.status === 'queued' || job.status === 'running' || job.status === 'ready' ? (
          <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>
            {copy.refreshStatusAction}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function DeletionStatusBlock({
  job,
  locale,
  copy,
  refreshing,
  onRefresh,
}: {
  job: AnyPrivacyDeletion
  locale: 'fr' | 'en'
  copy: ReturnType<typeof privacyCopy>
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-sunken p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-c-ink-3">
          {copy.requestIdLabel}: {job.id}
        </span>
        <StatusPill state={DELETION_PILL[job.status]}>
          {copy.deletionStatuses[job.status]}
        </StatusPill>
      </div>

      <DefinitionList
        items={[
          {
            term: copy.requestedAtLabel,
            description: formatDate(job.requestedAt, locale),
          },
          {
            term: copy.updatedAtLabel,
            description: formatDate(job.updatedAt, locale),
          },
          ...(job.purgeAfter
            ? [
                {
                  term: copy.purgeAfterLabel,
                  description: (
                    <span className="font-mono font-medium text-c-ink">
                      {formatDate(job.purgeAfter, locale)}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />

      {job.failureCode !== null ? (
        <InlineAlert kind={job.failureCode === 'legal_hold' ? 'warning' : 'error'}>
          {copy.failureReasons[job.failureCode]}
        </InlineAlert>
      ) : null}

      {job.status === 'queued' ||
      job.status === 'running' ||
      job.status === 'retention_pending' ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>
            {copy.refreshStatusAction}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function WorkspacePrivacyPanel({
  org,
  organisationId,
  role,
  initialAccountExport,
  initialWorkspaceExport,
  initialAccountDeletion,
  initialWorkspaceDeletion,
}: WorkspacePrivacyPanelProps) {
  const { i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = privacyCopy(i18n.resolvedLanguage)
  const isOwner = role === 'org_owner'

  const accountMediaCheckboxId = useId()
  const workspaceMediaCheckboxId = useId()
  const [nowMs, setNowMs] = useState(Date.now)
  const [includeAccountMedia, setIncludeAccountMedia] = useState(true)
  const [includeWorkspaceMedia, setIncludeWorkspaceMedia] = useState(true)

  const [accountExport, setAccountExport] = useState<AnyPrivacyExport | null>(
    initialAccountExport ?? null
  )
  const [workspaceExport, setWorkspaceExport] = useState<AnyPrivacyExport | null>(
    initialWorkspaceExport ?? null
  )
  const [accountDeletion, setAccountDeletion] = useState<AnyPrivacyDeletion | null>(
    initialAccountDeletion ?? null
  )
  const [workspaceDeletion, setWorkspaceDeletion] = useState<AnyPrivacyDeletion | null>(
    initialWorkspaceDeletion ?? null
  )

  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [holdBanner, setHoldBanner] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [workspaceConfirmSlug, setWorkspaceConfirmSlug] = useState('')
  const [workspaceReason, setWorkspaceReason] = useState('')
  const [accountConfirmSlug, setAccountConfirmSlug] = useState('')
  const [accountReason, setAccountReason] = useState('')

  function clearFeedback() {
    setNowMs(Date.now())
    setHoldBanner(null)
    setErrorMessage(null)
  }

  function recordFailure(error: unknown) {
    const classified = classifyPrivacyError(error, copy)
    if (classified.hold503) {
      setHoldBanner(classified.message)
    } else {
      setErrorMessage(classified.message)
    }
  }

  async function handleRequestAccountExport() {
    if (busyKey !== null) return
    clearFeedback()
    setBusyKey('req-acc-export')
    try {
      const created = await requestAccountExport({ includeMedia: includeAccountMedia })
      setAccountExport(created)
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRefreshAccountExport() {
    if (!accountExport || busyKey !== null) return
    clearFeedback()
    setBusyKey('ref-acc-export')
    try {
      setAccountExport(await getAccountExport(accountExport.id))
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleDownloadAccountExport() {
    if (!accountExport || busyKey !== null) return
    clearFeedback()
    setBusyKey('dl-acc-export')
    try {
      const link = await getAccountExportDownloadLink(accountExport.id)
      window.open(link.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRequestWorkspaceExport() {
    if (!isOwner || busyKey !== null) return
    clearFeedback()
    setBusyKey('req-ws-export')
    try {
      const created = await requestWorkspaceExport(organisationId, {
        includeMedia: includeWorkspaceMedia,
      })
      setWorkspaceExport(created)
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRefreshWorkspaceExport() {
    if (!workspaceExport || busyKey !== null) return
    clearFeedback()
    setBusyKey('ref-ws-export')
    try {
      setWorkspaceExport(await getWorkspaceExport(organisationId, workspaceExport.id))
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleDownloadWorkspaceExport() {
    if (!workspaceExport || busyKey !== null) return
    clearFeedback()
    setBusyKey('dl-ws-export')
    try {
      const link = await getWorkspaceExportDownloadLink(organisationId, workspaceExport.id)
      window.open(link.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleConfirmWorkspaceDeletion(event: React.FormEvent) {
    event.preventDefault()
    if (!isOwner || workspaceConfirmSlug !== org || busyKey !== null) return
    clearFeedback()
    setBusyKey('req-ws-del')
    try {
      const created = await requestWorkspaceDeletion(organisationId, {
        ...(workspaceReason.trim() ? { reason: workspaceReason.trim() } : {}),
      })
      setWorkspaceDeletion(created)
      setWorkspaceConfirmSlug('')
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRefreshWorkspaceDeletion() {
    if (!workspaceDeletion || busyKey !== null) return
    clearFeedback()
    setBusyKey('ref-ws-del')
    try {
      setWorkspaceDeletion(await getWorkspaceDeletion(organisationId, workspaceDeletion.id))
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleConfirmAccountDeletion(event: React.FormEvent) {
    event.preventDefault()
    if (accountConfirmSlug !== org || busyKey !== null) return
    clearFeedback()
    setBusyKey('req-acc-del')
    try {
      const created = await requestAccountDeletion({
        ...(accountReason.trim() ? { reason: accountReason.trim() } : {}),
      })
      setAccountDeletion(created)
      setAccountConfirmSlug('')
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRefreshAccountDeletion() {
    if (!accountDeletion || busyKey !== null) return
    clearFeedback()
    setBusyKey('ref-acc-del')
    try {
      setAccountDeletion(await getAccountDeletion(accountDeletion.id))
    } catch (error) {
      recordFailure(error)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-c-ink-2">{copy.intro}</p>

      {holdBanner !== null ? <Banner kind="incident" headline={holdBanner} /> : null}
      {errorMessage !== null ? <InlineAlert kind="error">{errorMessage}</InlineAlert> : null}

      <section className="flex flex-col gap-5 rounded-lg border border-c-border p-5">
        <h3 className="text-lg font-semibold text-c-ink">{copy.exportSectionTitle}</h3>

        <div className="flex flex-col gap-3 border-b border-c-border-soft pb-5">
          <h4 className="text-sm font-semibold text-c-ink">{copy.accountExportTitle}</h4>
          <p className="text-sm text-c-ink-2">{copy.accountExportHint}</p>
          <label
            htmlFor={accountMediaCheckboxId}
            className="flex items-center gap-2 text-sm text-c-ink"
          >
            <input
              id={accountMediaCheckboxId}
              type="checkbox"
              checked={includeAccountMedia}
              onChange={(event) => setIncludeAccountMedia(event.target.checked)}
              className="h-[18px] w-[18px] shrink-0 rounded-[4px] border border-c-border-input focus-visible:ring"
            />
            <span>{copy.includeMediaLabel}</span>
          </label>
          <div>
            <Button
              variant="secondary"
              loading={busyKey === 'req-acc-export'}
              onClick={() => void handleRequestAccountExport()}
            >
              {copy.requestAccountExportAction}
            </Button>
          </div>
          {accountExport !== null ? (
            <ExportStatusBlock
              job={accountExport}
              nowMs={nowMs}
              locale={locale}
              copy={copy}
              refreshing={busyKey === 'ref-acc-export'}
              downloading={busyKey === 'dl-acc-export'}
              onRefresh={() => void handleRefreshAccountExport()}
              onDownload={() => void handleDownloadAccountExport()}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-c-ink">{copy.workspaceExportTitle}</h4>
          <p className="text-sm text-c-ink-2">{copy.workspaceExportHint}</p>
          {isOwner ? (
            <>
              <label
                htmlFor={workspaceMediaCheckboxId}
                className="flex items-center gap-2 text-sm text-c-ink"
              >
                <input
                  id={workspaceMediaCheckboxId}
                  type="checkbox"
                  checked={includeWorkspaceMedia}
                  onChange={(event) => setIncludeWorkspaceMedia(event.target.checked)}
                  className="h-[18px] w-[18px] shrink-0 rounded-[4px] border border-c-border-input focus-visible:ring"
                />
                <span>{copy.includeMediaLabel}</span>
              </label>
              <div>
                <Button
                  variant="secondary"
                  loading={busyKey === 'req-ws-export'}
                  onClick={() => void handleRequestWorkspaceExport()}
                >
                  {copy.requestWorkspaceExportAction}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs text-c-ink-3">{copy.workspaceOwnerOnlyNotice}</p>
          )}
          {workspaceExport !== null ? (
            <ExportStatusBlock
              job={workspaceExport}
              nowMs={nowMs}
              locale={locale}
              copy={copy}
              refreshing={busyKey === 'ref-ws-export'}
              downloading={busyKey === 'dl-ws-export'}
              onRefresh={() => void handleRefreshWorkspaceExport()}
              onDownload={() => void handleDownloadWorkspaceExport()}
            />
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-5 rounded-lg border border-c-border p-5">
        <h3 className="text-lg font-semibold text-c-ink">{copy.erasureSectionTitle}</h3>

        <div className="flex flex-col gap-2 rounded-md border border-c-border bg-c-sunken p-4">
          <p className="text-sm font-semibold text-c-ink">{copy.statutoryRetentionTitle}</p>
          <p className="text-sm text-c-ink-2">{copy.statutoryRetentionBody}</p>
        </div>

        <div className="flex flex-col gap-3 border-b border-c-border-soft pb-5">
          <h4 className="text-sm font-semibold text-c-ink">{copy.workspaceErasureTitle}</h4>
          <p className="text-sm text-c-ink-2">{copy.workspaceErasureHint}</p>
          {isOwner ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => void handleConfirmWorkspaceDeletion(event)}
            >
              <TextField
                label={copy.confirmSlugLabel(org)}
                value={workspaceConfirmSlug}
                onChange={(event) => setWorkspaceConfirmSlug(event.target.value)}
              />
              <TextField
                label={copy.deletionReasonLabel}
                maxLength={240}
                value={workspaceReason}
                onChange={(event) => setWorkspaceReason(event.target.value)}
              />
              <div>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={workspaceConfirmSlug !== org}
                  loading={busyKey === 'req-ws-del'}
                >
                  {copy.confirmWorkspaceDeletionAction}
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-xs text-c-ink-3">{copy.workspaceOwnerOnlyNotice}</p>
          )}
          {workspaceDeletion !== null ? (
            <DeletionStatusBlock
              job={workspaceDeletion}
              locale={locale}
              copy={copy}
              refreshing={busyKey === 'ref-ws-del'}
              onRefresh={() => void handleRefreshWorkspaceDeletion()}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-c-ink">{copy.accountErasureTitle}</h4>
          <p className="text-sm text-c-ink-2">{copy.accountErasureHint}</p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => void handleConfirmAccountDeletion(event)}
          >
            <TextField
              label={copy.confirmSlugLabel(org)}
              value={accountConfirmSlug}
              onChange={(event) => setAccountConfirmSlug(event.target.value)}
            />
            <TextField
              label={copy.deletionReasonLabel}
              maxLength={240}
              value={accountReason}
              onChange={(event) => setAccountReason(event.target.value)}
            />
            <div>
              <Button
                type="submit"
                variant="destructive"
                disabled={accountConfirmSlug !== org}
                loading={busyKey === 'req-acc-del'}
              >
                {copy.confirmAccountDeletionAction}
              </Button>
            </div>
          </form>
          {accountDeletion !== null ? (
            <DeletionStatusBlock
              job={accountDeletion}
              locale={locale}
              copy={copy}
              refreshing={busyKey === 'ref-acc-del'}
              onRefresh={() => void handleRefreshAccountDeletion()}
            />
          ) : null}
        </div>
      </section>
    </div>
  )
}
