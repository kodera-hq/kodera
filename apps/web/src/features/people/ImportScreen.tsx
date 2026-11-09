// docs/specs/03-people.md §4.3: import a list. Upload, map and preview, send,
// result. Router-free: the route passes the import id once the upload exists
// and remounts the screen with it, so every step after the upload is rebuilt
// from `GET /member-imports/{id}` rather than from memory.
//
// Privacy (§4.3, ADR-0011): the raw file never stays on the server, and the
// console keeps no copy either. Only the rows on screen are ever held, the
// failed rows are downloaded from what is displayed, and a completed import
// renders its durable counts only.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { useOnlineStatus } from '../../app/useOnlineStatus'
import type { MessageKey } from '../../i18n'
import { formatDate, type Locale } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { FileDrop } from '../../ui/FileDrop/FileDrop'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { Select } from '../../ui/Select/Select'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { Spinner } from '../../ui/Spinner/Spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../../ui/Table/Table'
import { useToast } from '../../ui/Toast/Toast'
import { useLocale } from '../invoices/useLocale'
import {
  trackImportExecuted,
  trackImportParsed,
  trackImportRetry,
  trackImportStarted,
} from './analytics'
import {
  assign,
  buildCsv,
  downloadCsv,
  failedLine,
  guessMapping,
  mappingFrom,
  toColumnMapping,
  type FieldChoice,
  type Mapping,
} from './importCsv'
import {
  executeMemberImport,
  mapMemberImport,
  memberImportQuery,
  uploadMemberImport,
  useMemberImportQuery,
  type ColumnMapping,
} from './memberImport'
import type { PeopleTarget } from './PeopleScreen'
import { useInvalidatePeople, type MemberImport, type Tagged } from './queries'
import { invitableRoles, type InvitationRole, type OrganisationRole } from './roles'
import { PAGE_TITLE } from '../../ui/pageTitle'

/** §8: the same limits the server enforces, checked on drop first. */
const MAX_BYTES = 2 * 1024 * 1024

const ROLE_OPTION: Record<InvitationRole, MessageKey> = {
  org_member: 'console.people.invite.label-role-member',
  org_admin: 'console.people.invite.label-role-admin',
  org_billing: 'console.people.invite.label-role-billing',
}

const FIELD_LABEL: Record<FieldChoice, MessageKey> = {
  email: 'console.people.import.label-field-email',
  given_name: 'console.people.import.label-field-given-name',
  family_name: 'console.people.import.label-field-family-name',
  role: 'console.people.import.label-field-role',
  ignore: 'console.people.import.label-field-ignore',
}

const FIELD_ORDER: readonly FieldChoice[] = ['email', 'given_name', 'family_name', 'role', 'ignore']

/** §9: `reason_code` is a closed code, mapped here, never shown raw. */
function reasonKey(code: string | null | undefined): MessageKey {
  if (code === 'invalid_email') return 'console.people.invite.error-address-invalid'
  if (code === 'mail_provider_rejected') return 'console.people.invite.error-mailbox-unreachable'
  if (code === 'already_invited') return 'console.people.invite.error-already-invited'
  return 'console.common.error-unavailable'
}

type Summary = NonNullable<MemberImport['summary']>
type FailedRow = NonNullable<MemberImport['rows']>[number]

/** Server states that render the result; the rest are before or during the send. */
const FINISHED: ReadonlySet<MemberImport['state']> = new Set([
  'completed',
  'partially_failed',
  'failed',
  'discarded',
])

export interface ImportScreenProps {
  organisationId: string
  callerRole: OrganisationRole
  /** Set by the route once the upload exists: the screen resumes from the server. */
  importId?: string
  source?: 'order' | 'status'
  onImportStarted: (importId: string) => void
  onNavigate: (target: PeopleTarget) => void
}

export function ImportScreen({
  organisationId,
  callerRole,
  importId,
  source,
  onImportStarted,
  onNavigate,
}: ImportScreenProps) {
  const { t } = useTranslation()
  const notify = useToast()
  const online = useOnlineStatus()
  const locale = useLocale()
  const client = useQueryClient()
  const invalidatePeople = useInvalidatePeople(organisationId)
  const [uploadedId, setUploadedId] = useState<string | null>(null)
  const id = importId ?? uploadedId
  const query = useMemberImportQuery(id)
  const [sending, setSending] = useState<{ total: number } | null>(null)
  const [executeFailed, setExecuteFailed] = useState(false)
  /** The send succeeded but its result could not be read back yet. */
  const [unreconciled, setUnreconciled] = useState<{ total: number; created: number } | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [finished, setFinished] = useState('')
  const attempt = useRef<{ intent: string; key: string } | null>(null)

  const started = useRef(false)
  useEffect(() => {
    if (started.current || importId !== undefined) return
    started.current = true
    trackImportStarted(source ?? 'button')
  }, [importId, source])

  function downloadTemplate() {
    // Headers only: the template carries no example person.
    const header = (['email', 'given_name', 'family_name', 'role'] as const).map((field) =>
      t(FIELD_LABEL[field])
    )
    downloadCsv(t('console.people.import.label-template-filename'), buildCsv([header]))
  }

  async function execute(onlyLines?: number[]) {
    if (id === null || query.data === undefined) return
    const total = onlyLines?.length ?? query.data.value.summary?.ready ?? 0
    // Same rows after a failure that may have reached the server: same
    // Idempotency-Key, so the retry cannot send a second batch.
    const intent = JSON.stringify(onlyLines ?? null)
    if (attempt.current?.intent !== intent) {
      attempt.current = { intent, key: crypto.randomUUID() }
    }
    if (onlyLines !== undefined) trackImportRetry(onlyLines.length)
    setExecuteFailed(false)
    setFinished('')
    setSending({ total })
    let created: number
    try {
      const batch = await executeMemberImport(
        id,
        { ...(onlyLines === undefined ? {} : { onlyLines }), locale },
        attempt.current.key
      )
      trackImportExecuted(batch.created, batch.failed)
      created = batch.created
    } catch {
      setExecuteFailed(true)
      setSending(null)
      return
    }
    await reconcile({ total, created })
    setSending(null)
  }

  /**
   * Reads the import back after a successful send. The Idempotency-Key is
   * kept until this read succeeds: a send whose result is unknown is never
   * reported as failed, and only the read is retried.
   */
  async function reconcile(sent: { total: number; created: number }) {
    if (id === null) return
    try {
      const next = await client.fetchQuery({ ...memberImportQuery(id), staleTime: 0 })
      attempt.current = null
      setUnreconciled(null)
      await invalidatePeople()
      setFinished(
        t('console.people.import.status-sending', { done: sent.total, total: sent.total })
      )
      if (next.value.state === 'completed') {
        notify({
          kind: 'success',
          title: t('console.people.invite.toast-sent', {
            count: next.value.summary?.invited ?? sent.created,
          }),
        })
      }
    } catch {
      setUnreconciled(sent)
    }
  }

  async function retryReconcile() {
    if (unreconciled === null) return
    setReconciling(true)
    try {
      await reconcile(unreconciled)
    } finally {
      setReconciling(false)
    }
  }

  const record = query.data
  const running = record?.value.state === 'running'
  const progress =
    sending !== null
      ? { done: 0, total: sending.total }
      : running
        ? {
            done: record.value.summary?.invited ?? 0,
            total: record.value.summary?.ready ?? record.value.row_count,
          }
        : null

  let body: React.ReactNode
  if (id === null) {
    body = (
      <UploadStep
        organisationId={organisationId}
        online={online}
        onTemplate={downloadTemplate}
        onUploaded={(created) => {
          client.removeQueries({ queryKey: memberImportQuery(created.id).queryKey })
          setUploadedId(created.id)
          onImportStarted(created.id)
        }}
      />
    )
  } else if (progress !== null) {
    body = (
      <div className="flex items-center gap-3">
        <Spinner />
        <p className="text-sm text-c-ink">{t('console.people.import.status-sending', progress)}</p>
      </div>
    )
  } else if (unreconciled !== null) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
        <Button variant="secondary" loading={reconciling} onClick={() => void retryReconcile()}>
          {t('console.common.action-retry')}
        </Button>
      </div>
    )
  } else if (record === undefined) {
    body = query.isError ? (
      <div className="flex flex-col items-start gap-3">
        <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          {t('console.common.action-retry')}
        </Button>
      </div>
    ) : (
      <div className="flex flex-col gap-3">
        <Skeleton label={t('console.common.a11y-loading')} />
        <Skeleton />
      </div>
    )
  } else if (FINISHED.has(record.value.state)) {
    body = (
      <ResultStep
        record={record.value}
        online={online}
        locale={locale}
        executeFailed={executeFailed}
        onRetry={(lines) => void execute(lines)}
        onNavigate={onNavigate}
      />
    )
  } else {
    body = (
      <PreviewStep
        key={record.value.id}
        record={record}
        callerRole={callerRole}
        online={online}
        locale={locale}
        executeFailed={executeFailed}
        onExecute={() => void execute()}
        onTemplate={downloadTemplate}
        onCancel={() => onNavigate({ to: '' })}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className={PAGE_TITLE}>{t('console.people.import.title')}</h1>
      {record !== undefined && query.isError && unreconciled === null ? (
        // Polling stopped after failed reads (memberImport.ts): say so, offer the read again.
        <div className="flex flex-col items-start gap-3">
          <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
          <Button
            variant="secondary"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t('console.common.action-retry')}
          </Button>
        </div>
      ) : null}
      {body}
      {/* §10: the send is announced at 0 %, 50 % and 100 % only. The region
          stays mounted so each change is heard; its text moves only when the
          count crosses one of those three marks. */}
      <p aria-live="polite" className="sr-only">
        {progress === null
          ? finished
          : t('console.people.import.status-sending', {
              done: milestone(progress.done, progress.total),
              total: progress.total,
            })}
      </p>
    </div>
  )
}

function milestone(done: number, total: number): number {
  if (total === 0 || done >= total) return total
  return done * 2 >= total ? Math.round(total / 2) : 0
}

// ——— Step 1: upload ———

type UploadError =
  | { key: 'console.people.import.error-parse-failed'; line: number }
  | {
      key:
        | 'console.people.import.error-upload-failed'
        | 'console.people.import.error-file-too-large'
        | 'console.people.import.error-file-type'
        | 'console.people.import.error-parse-failed-unknown-line'
    }

function UploadStep({
  organisationId,
  online,
  onTemplate,
  onUploaded,
}: {
  organisationId: string
  online: boolean
  onTemplate: () => void
  onUploaded: (created: MemberImport) => void
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<UploadError | null>(null)
  const [uploading, setUploading] = useState(false)
  // Remounting the drop zone after a refusal puts it back empty, so the next
  // file can be dropped straight away (acceptance test 7).
  const [attempt, setAttempt] = useState(0)
  // One Idempotency-Key per file: the same file dropped again after a failure
  // that may have reached the server cannot stage a second import. A server
  // answer, success or refusal, ends the intent.
  const intent = useRef<{ file: string; key: string } | null>(null)

  async function upload(file: File) {
    const identity = JSON.stringify([file.name, file.size, file.lastModified])
    if (intent.current?.file !== identity) {
      intent.current = { file: identity, key: crypto.randomUUID() }
    }
    setError(null)
    setUploading(true)
    try {
      const created = await uploadMemberImport(organisationId, file, intent.current.key)
      intent.current = null
      onUploaded(created)
    } catch (failure) {
      if (failure instanceof ApiProblem) intent.current = null
      setError(uploadError(failure))
      setAttempt((count) => count + 1)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <FileDrop
        key={attempt}
        label={t('console.people.import.label-drop')}
        help={t('console.people.import.hint-formats')}
        accept=".csv,text/csv"
        maxSize={MAX_BYTES}
        disabled={!online || uploading}
        {...(error === null
          ? {}
          : {
              error:
                error.key === 'console.people.import.error-parse-failed'
                  ? t(error.key, { line: error.line })
                  : t(error.key),
            })}
        rejectionMessage={(reason) =>
          reason === 'size'
            ? t('console.people.import.error-file-too-large')
            : t('console.people.import.error-file-type')
        }
        removeLabel={t('console.common.action-cancel')}
        onFileChange={(file) => (file === null ? undefined : void upload(file))}
      />
      {uploading ? <Spinner label={t('console.common.a11y-loading')} /> : null}
      {online ? null : <p className="text-xs text-c-ink-3">{t('console.common.error-offline')}</p>}
      <div className="flex flex-col gap-1 text-sm text-c-ink-2">
        <p>{t('console.people.import.hint-columns')}</p>
        <p>{t('console.people.import.hint-raw-deleted')}</p>
      </div>
      <div>
        <Button variant="secondary" onClick={onTemplate}>
          {t('console.people.import.action-template')}
        </Button>
      </div>
    </div>
  )
}

/** §9: a refusal becomes one catalogue sentence; `title` and `detail` never render. */
function uploadError(failure: unknown): UploadError {
  if (!(failure instanceof ApiProblem)) return { key: 'console.people.import.error-upload-failed' }
  switch (failure.type) {
    case 'https://kodera.io/problems/payload-too-large':
      return { key: 'console.people.import.error-file-too-large' }
    case 'https://kodera.io/problems/unsupported-media-type':
      return { key: 'console.people.import.error-file-type' }
    case 'https://kodera.io/problems/validation-error':
    case 'https://kodera.io/problems/malformed-request': {
      const line = failedLine(failure.errors)
      return line === null
        ? { key: 'console.people.import.error-parse-failed-unknown-line' }
        : { key: 'console.people.import.error-parse-failed', line }
    }
    default:
      return { key: 'console.people.import.error-upload-failed' }
  }
}

// ——— Step 2: mapping and preview ———

const PRECONDITION_FAILED = 'https://kodera.io/problems/precondition-failed'

interface MappingInput {
  mapping: ColumnMapping
  role: InvitationRole
}

function PreviewStep({
  record,
  callerRole,
  online,
  locale,
  executeFailed,
  onExecute,
  onTemplate,
  onCancel,
}: {
  record: Tagged<MemberImport>
  callerRole: OrganisationRole
  online: boolean
  locale: Locale
  executeFailed: boolean
  onExecute: () => void
  onTemplate: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const value = record.value
  const roles = invitableRoles(callerRole)
  const counterId = useId()
  const [mapping, setMapping] = useState<Mapping>(() =>
    value.column_mapping === null || value.column_mapping === undefined
      ? guessMapping(value.detected_columns)
      : mappingFrom(value.detected_columns, value.column_mapping)
  )
  const [role, setRole] = useState<InvitationRole>(() =>
    value.default_role !== undefined && roles.includes(value.default_role)
      ? value.default_role
      : 'org_member'
  )
  const [emailMissing, setEmailMissing] = useState(false)

  // One PATCH at a time: a change made while one is in flight is kept as
  // `wanted` and sent once it settles, so two writes never race on one tag.
  const wanted = useRef<MappingInput | null>(null)
  const sent = useRef<MappingInput | null>(null)
  const inFlight = useRef(false)

  const patch = useMutation({
    mutationFn: async (input: MappingInput) => {
      let patched: MemberImport
      try {
        patched = await mapMemberImport(value.id, input.mapping, input.role)
      } catch (error) {
        if (!(error instanceof ApiProblem) || error.type !== PRECONDITION_FAILED) throw error
        // The server rewrote the record between the read and the write:
        // read it again and re-apply the latest choice, once.
        const latest = wanted.current ?? input
        sent.current = latest
        patched = await mapMemberImport(value.id, latest.mapping, latest.role)
      }
      // The preview on screen is the server's, read back with its new tag.
      await client.invalidateQueries({ queryKey: memberImportQuery(value.id).queryKey })
      return patched
    },
    onSuccess: (patched) => {
      if (patched.summary === undefined) return
      trackImportParsed({
        rows: patched.row_count,
        ready: patched.summary.ready ?? 0,
        already_member: patched.summary.already_member ?? 0,
        duplicate: patched.summary.duplicate ?? 0,
        invalid: patched.summary.invalid ?? 0,
      })
    },
  })

  const { mutateAsync } = patch
  const send = useCallback(
    (input: MappingInput) => {
      wanted.current = input
      function drain() {
        const next = wanted.current
        if (inFlight.current || next === null || next === sent.current) return
        inFlight.current = true
        sent.current = next
        void mutateAsync(next)
          .catch(() => undefined)
          .finally(() => {
            inFlight.current = false
            drain()
          })
      }
      drain()
    },
    [mutateAsync]
  )

  // A fresh upload has columns and no mapping yet: the first guess is sent
  // straight away, so the counters appear without a click.
  const firstGuess = useRef(false)
  useEffect(() => {
    if (firstGuess.current || value.state !== 'uploaded') return
    firstGuess.current = true
    const initial = toColumnMapping(mapping)
    if (initial !== null) send({ mapping: initial, role })
  }, [mapping, send, role, value.state])

  function remap(nextMapping: Mapping, nextRole: InvitationRole) {
    setMapping(nextMapping)
    setRole(nextRole)
    const columns = toColumnMapping(nextMapping)
    if (columns !== null) {
      setEmailMissing(false)
      send({ mapping: columns, role: nextRole })
    }
  }

  const summary = value.summary
  const validating = patch.isPending || value.state === 'validating'
  const previewed = !validating && value.state === 'ready' && summary !== undefined
  const ready = summary?.ready ?? 0

  function submit() {
    if (toColumnMapping(mapping) === null) {
      setEmailMissing(true)
      return
    }
    if (previewed && ready > 0) onExecute()
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold text-c-ink">
        {t('console.people.import.title-mapping', { rows: value.row_count })}
      </h2>

      <Table caption={t('console.people.import.label-mapping-caption')}>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t('console.people.import.label-column-file')}</TableHeaderCell>
            <TableHeaderCell>{t('console.people.import.label-column-field')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {value.detected_columns.map((column) => {
            const name =
              column.header ??
              t('console.people.import.label-column-number', { number: column.index + 1 })
            return (
              <TableRow key={column.index}>
                <TableHeaderCell scope="row" className="normal-case">
                  <span className="block text-sm font-medium text-c-ink">{name}</span>
                  {column.sample === null || column.sample === undefined ? null : (
                    <span className="block text-xs font-regular text-c-ink-3">
                      {t('console.people.import.label-sample', { sample: column.sample })}
                    </span>
                  )}
                </TableHeaderCell>
                <TableCell>
                  <Select
                    className="[&>label]:sr-only"
                    label={t('console.people.import.a11y-field-for-column', { column: name })}
                    value={mapping[column.index] ?? 'ignore'}
                    options={FIELD_ORDER.map((field) => ({
                      value: field,
                      label: t(FIELD_LABEL[field]),
                    }))}
                    onValueChange={(choice) =>
                      remap(assign(mapping, column.index, choice as FieldChoice), role)
                    }
                  />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {emailMissing ? (
        <InlineAlert kind="error">
          {t('console.people.import.error-email-column-required')}
        </InlineAlert>
      ) : null}
      {patch.isError ? (
        <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
      ) : null}

      {validating ? (
        <div className="flex flex-col gap-2">
          <Skeleton label={t('console.common.a11y-loading')} />
          <Skeleton />
        </div>
      ) : previewed ? (
        <PreviewCounters id={counterId} summary={summary} />
      ) : null}

      <RadioGroup
        label={t('console.people.import.label-default-role')}
        value={role}
        onValueChange={(next) => remap(mapping, next as InvitationRole)}
        options={roles.map((option) => ({ value: option, label: t(ROLE_OPTION[option]) }))}
      />

      <p className="text-xs text-c-ink-3">
        {t('console.people.import.hint-preview-expiry', {
          date: formatDate(value.staging_expires_at, locale),
        })}
      </p>

      {executeFailed ? (
        <InlineAlert kind="error">{t('console.people.import.error-execute-failed')}</InlineAlert>
      ) : null}

      {previewed && ready === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <InlineAlert kind="warning">
            {t('console.people.import.empty-no-usable-rows')}
          </InlineAlert>
          <Button variant="secondary" onClick={onTemplate}>
            {t('console.people.import.action-template')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={validating}
            disabled={!online}
            aria-describedby={previewed ? counterId : undefined}
            onClick={submit}
          >
            {t('console.people.import.action-execute', { count: ready })}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t('console.common.action-cancel')}
          </Button>
          {online ? null : (
            <span className="text-xs text-c-ink-3">{t('console.common.error-offline')}</span>
          )}
        </div>
      )}
    </div>
  )
}

/** §10: a list of sentences, each with its count inside, not coloured tiles. */
function PreviewCounters({ id, summary }: { id: string; summary: Summary }) {
  const { t } = useTranslation()
  return (
    <ul id={id} className="flex flex-col gap-1 text-sm text-c-ink">
      <li>{t('console.people.import.status-ready', { count: summary.ready ?? 0 })}</li>
      <li>
        {t('console.people.import.status-already-member', { count: summary.already_member ?? 0 })}
      </li>
      {(summary.already_invited ?? 0) > 0 ? (
        <li>
          {t('console.people.import.status-already-invited', {
            count: summary.already_invited ?? 0,
          })}
        </li>
      ) : null}
      <li>{t('console.people.import.status-duplicate', { count: summary.duplicate ?? 0 })}</li>
      <li>{t('console.people.import.status-invalid', { count: summary.invalid ?? 0 })}</li>
    </ul>
  )
}

// ——— Step 3: result ———

function ResultStep({
  record,
  online,
  locale,
  executeFailed,
  onRetry,
  onNavigate,
}: {
  record: MemberImport
  online: boolean
  locale: Locale
  executeFailed: boolean
  onRetry: (lines: number[]) => void
  onNavigate: (target: PeopleTarget) => void
}) {
  const { t } = useTranslation()
  // After a partial failure only retryable rows remain (contract `rows`);
  // after completion or discard the array is empty and nothing personal shows.
  const failures: FailedRow[] = record.rows ?? []

  function downloadFailures() {
    downloadCsv(
      t('console.people.import.label-failures-filename'),
      buildCsv([
        [
          t('console.people.import.label-column-line'),
          t('console.people.import.label-field-email'),
          t('console.people.import.label-column-reason'),
        ],
        ...failures.map((row) => [
          String(row.line),
          row.email ?? '',
          t(reasonKey(row.reason_code)),
        ]),
      ])
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold text-c-ink">
        {t('console.people.import.title-result', { sent: record.summary?.invited ?? 0 })}
      </h2>

      {failures.length === 0 ? (
        record.state === 'completed' ? (
          <Card>
            <CardBody className="flex flex-col items-start gap-3">
              <p className="text-sm text-c-ink-2">{t('console.people.import.body-completed')}</p>
              <Button variant="secondary" onClick={() => onNavigate({ to: 'invitations' })}>
                {t('console.people.import.action-view-invitations')}
              </Button>
            </CardBody>
          </Card>
        ) : null
      ) : (
        <section className="flex flex-col gap-4">
          <h3 className="text-md font-semibold text-c-ink">
            {t('console.people.import.title-failures', { count: failures.length })}
          </h3>
          <Table caption={t('console.people.import.label-failures-caption')}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('console.people.import.label-column-line')}</TableHeaderCell>
                <TableHeaderCell>{t('console.people.import.label-field-email')}</TableHeaderCell>
                <TableHeaderCell>{t('console.people.import.label-column-reason')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {failures.map((row) => (
                <TableRow key={row.line}>
                  <TableHeaderCell scope="row" className="text-c-ink normal-case">
                    {t('console.people.import.label-line', { line: row.line })}
                  </TableHeaderCell>
                  <TableCell className="font-mono">{row.email ?? ''}</TableCell>
                  <TableCell className="text-c-ink-2">{t(reasonKey(row.reason_code))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {executeFailed ? (
            <InlineAlert kind="error">
              {t('console.people.import.error-execute-failed')}
            </InlineAlert>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!online} onClick={() => onRetry(failures.map((row) => row.line))}>
              {t('console.people.import.action-retry-failed', { count: failures.length })}
            </Button>
            <Button variant="secondary" onClick={downloadFailures}>
              {t('console.people.import.action-download-failures')}
            </Button>
            {online ? null : (
              <span className="text-xs text-c-ink-3">{t('console.common.error-offline')}</span>
            )}
          </div>
          <p className="text-xs text-c-ink-3">
            {t('console.people.import.hint-staging-expiry', {
              date: formatDate(record.staging_expires_at, locale),
            })}
          </p>
        </section>
      )}
    </div>
  )
}
