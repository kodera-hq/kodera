// docs/specs/03-people.md §4.2: invite by email. The field takes a paste
// from a spreadsheet; the counter says what it recognised; a partial failure
// keeps the drawer open, names each address that did not go through, and the
// retry sends only those.

import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { ApiProblem } from '../../api/client'
import { useOnlineStatus } from '../../app/useOnlineStatus'
import type { MessageKey } from '../../i18n'
import { authAdapter } from '../../auth/oidc'
import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import { onBeforeSignIn } from '../../auth/beforeSignIn'
import {
  canSaveInvitation,
  clearInvitation,
  consumeInvitation,
  readInvitation,
  saveInvitation,
  type InvitationOwner,
} from './invitationRecovery'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Drawer } from '../../ui/Drawer/Drawer'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { useToast } from '../../ui/Toast/Toast'
import { offers } from '../../app/capabilities'
import { MAX_ADDRESSES, parseAddresses } from './addresses'
import { trackInviteResult, trackInviteSubmitted } from './analytics'
import { inviteBatch, useInvalidatePeople, type InvitationBatchResult } from './queries'
import { invitableRoles, type InvitationRole, type OrganisationRole } from './roles'

type Outcome = InvitationBatchResult['results'][number]['outcome']

const ROLE_OPTION: Record<InvitationRole, MessageKey> = {
  org_member: 'console.people.invite.label-role-member',
  org_admin: 'console.people.invite.label-role-admin',
  org_billing: 'console.people.invite.label-role-billing',
}

const OUTCOME_COPY: Record<Exclude<Outcome, 'created'>, MessageKey> = {
  invalid_email: 'console.people.invite.error-address-invalid',
  already_member: 'console.people.invite.error-already-member',
  already_invited: 'console.people.invite.error-already-invited',
  failed: 'console.common.error-unavailable',
}

/** Outcomes the person can act on by sending again; the others are informational. */
const RETRYABLE: ReadonlySet<Outcome> = new Set(['invalid_email', 'failed'])

interface Rejection {
  email: string
  outcome: Exclude<Outcome, 'created'>
}

// Only the fields this drawer consumes constitute a batch acknowledgement.
// Optional invitation:null is valid; neither HTTP metadata nor unused fields
// are exposed by the existing mutation wrapper.
type BatchReceipt = Readonly<{
  created: number
  skipped: number
  failed: number
  results: readonly Readonly<{ email: string; outcome: Outcome }>[]
}>
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function consumedBatch(value: unknown, rows: readonly { email: string }[]): BatchReceipt {
  const n = rows.length
  const count = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= n
  if (
    !object(value) ||
    !count(value.created) ||
    !count(value.skipped) ||
    !count(value.failed) ||
    !Array.isArray(value.results) ||
    value.results.length !== n
  )
    throw new Error('Invitation receipt unavailable.')
  const seen = new Set<string>()
  const totals = { created: 0, skipped: 0, failed: 0 }
  const results = value.results.map((row: unknown, i: number) => {
    if (
      !object(row) ||
      typeof row.email !== 'string' ||
      row.email.toLowerCase() !== rows[i]!.email.toLowerCase() ||
      seen.has(row.email.toLowerCase()) ||
      typeof row.outcome !== 'string' ||
      !['created', 'already_member', 'already_invited', 'invalid_email', 'failed'].includes(
        row.outcome
      )
    )
      throw new Error('Invitation receipt row unavailable.')
    seen.add(row.email.toLowerCase())
    const outcome = row.outcome as Outcome
    if (outcome === 'created') totals.created++
    else if (outcome === 'already_member' || outcome === 'already_invited') totals.skipped++
    else totals.failed++
    return Object.freeze({ email: row.email, outcome })
  })
  if (
    totals.created !== value.created ||
    totals.skipped !== value.skipped ||
    totals.failed !== value.failed ||
    value.created + value.skipped + value.failed !== n
  )
    throw new Error('Invitation receipt counts unavailable.')
  return Object.freeze({ ...totals, results: Object.freeze(results) })
}
type AuthOwner = {
  generation: number
  realm: string | undefined
  identityPresent: boolean
  issuer: string | undefined
  subject: string | undefined
}
function authOwner(snapshot: AuthSessionSnapshot): AuthOwner | null {
  return snapshot.status !== 'ready'
    ? null
    : {
        generation: snapshot.generation,
        realm: snapshot.user?.realm,
        identityPresent: snapshot.user?.identity !== undefined,
        issuer: snapshot.user?.identity?.issuer,
        subject: snapshot.user?.identity?.subject,
      }
}
function sameAuth(a: AuthOwner | null, b: AuthOwner | null) {
  return a === null || b === null
    ? a === b
    : a.generation === b.generation &&
        a.realm === b.realm &&
        a.identityPresent === b.identityPresent &&
        a.issuer === b.issuer &&
        a.subject === b.subject
}
type Context = {
  organisationId: string
  callerRole: OrganisationRole
  owner: AuthOwner | null
  epoch: object
  live: boolean
  dismissed: boolean
}
type Intention = {
  context: Context
  payload: string
  key: string
  rows: readonly Readonly<{ email: string; role: InvitationRole }>[]
  receipt: BatchReceipt | null
}
type Invocation = {
  context: Context
  epoch: object
  owner: AuthOwner
  intention: Intention | null
  submissionAttempted: boolean
  resultAttempted: boolean
  toastAttempted: boolean
  callbackAttempted: boolean
}
function beforeReceiptFailure(failure: unknown): MessageKey {
  if (failure instanceof ApiProblem) {
    if (failure.status >= 500 && failure.status <= 599)
      return 'console.people.invite.error-send-unconfirmed'
    if (failure.status === 409 && failure.type === 'https://kodera.io/problems/quota-exceeded')
      return 'console.people.invite.error-seat-limit'
    if (failure.status >= 400 && failure.status <= 499)
      return 'console.people.invite.error-send-refused'
  }
  return 'console.people.invite.error-send-unconfirmed'
}
const SEND_ERRORS: ReadonlySet<MessageKey> = new Set([
  'console.people.invite.error-send-failed',
  'console.people.invite.error-seat-limit',
  'console.people.invite.error-send-unconfirmed',
  'console.people.invite.error-send-refused',
  'console.people.invite.error-result-finalization',
])

export interface InviteDrawerProps {
  organisationId: string
  callerRole: OrganisationRole
  recoveryOwner?: InvitationOwner
  onClose: () => void
  /** Every address went through; `count` invitations were created. */
  onSent: (count: number) => void
}

export function InviteDrawer(props: InviteDrawerProps) {
  return (
    <OwnedInviteDrawer key={JSON.stringify([props.organisationId, props.callerRole])} {...props} />
  )
}

// Stable module-level identity: a committed target/caller replacement owns a
// new private state lifetime. Credential rotation is deliberately not a key.
function OwnedInviteDrawer({
  organisationId,
  callerRole,
  recoveryOwner,
  onClose,
  onSent,
}: InviteDrawerProps) {
  const { t } = useTranslation()
  const notify = useToast()
  const online = useOnlineStatus()
  const invalidate = useInvalidatePeople(organisationId)
  const fieldId = useId()
  const helpId = useId()
  const counterId = useId()
  const errorId = useId()
  const resultId = useId()
  const [restored] = useState(() =>
    recoveryOwner !== undefined &&
    canSaveInvitation(recoveryOwner, authAdapter.getSnapshot()) &&
    authAdapter.getAccessToken() !== undefined
      ? readInvitation(recoveryOwner)
      : undefined
  )
  const [text, setText] = useState(restored?.draft.text ?? '')
  const [blurred, setBlurred] = useState(false)
  const [pasted, setPasted] = useState(false)
  const [role, setRole] = useState<InvitationRole>(restored?.draft.role ?? 'org_member')
  const [error, setError] = useState<MessageKey | null>(null)
  const [result, setResult] = useState<{ sent: number; rejected: Rejection[] } | null>(null)
  const [sending, setSending] = useState(false)
  const attempt = useRef<Intention | null>(null)
  const flight = useRef<Invocation | null>(null)
  const context = useRef<Context | null>(null)
  const fallback = useRef<Intention | null>(null)
  const [blockedPayload, setBlockedPayload] = useState<string | null>(null)

  useLayoutEffect(() => {
    const current: Context = {
      organisationId,
      callerRole,
      owner: authOwner(authAdapter.getSnapshot()),
      epoch: {},
      live: true,
      dismissed: false,
    }
    context.current = current
    const retire = () => {
      current.epoch = {}
      if (flight.current?.context === current) flight.current = null
      if (attempt.current?.context === current) attempt.current = null
      if (fallback.current?.context === current) fallback.current = null
    }
    const unsubscribe = authAdapter.subscribe(() => {
      if (!current.live || context.current !== current) return
      const next = authOwner(authAdapter.getSnapshot())
      if (sameAuth(current.owner, next)) return
      current.owner = next
      retire()
      setSending(false)
      setError(null)
      setResult(null)
      setBlockedPayload(null)
    })
    return () => {
      current.live = false
      retire()
      unsubscribe()
    }
  }, [organisationId, callerRole])

  function owns(invocation: Invocation) {
    return (
      flight.current === invocation &&
      context.current === invocation.context &&
      invocation.context.live &&
      invocation.context.epoch === invocation.epoch &&
      sameAuth(invocation.owner, authOwner(authAdapter.getSnapshot()))
    )
  }
  function dismiss() {
    const current = context.current
    if (current?.dismissed) return
    if (current) {
      current.dismissed = true
      current.live = false
      current.epoch = {}
      if (flight.current?.context === current) flight.current = null
      if (attempt.current?.context === current) attempt.current = null
      if (fallback.current?.context === current) fallback.current = null
    }
    onClose()
  }

  const recoveryEligible = useRef(true)
  const saveBeforeSignIn = useEffectEvent(() => {
    if (recoveryOwner === undefined) return
    if (!recoveryEligible.current || !canSaveInvitation(recoveryOwner, authAdapter.getSnapshot())) {
      clearInvitation()
      return
    }
    saveInvitation(recoveryOwner, { text, role, open: true })
  })
  useEffect(() => onBeforeSignIn(() => saveBeforeSignIn()), [])
  useEffect(() => {
    if (restored === undefined || recoveryOwner === undefined) return
    let committed = true
    queueMicrotask(() => {
      if (
        committed &&
        canSaveInvitation(recoveryOwner, authAdapter.getSnapshot()) &&
        authAdapter.getAccessToken() !== undefined
      )
        consumeInvitation(restored)
    })
    return () => {
      committed = false
    }
  }, [restored, recoveryOwner])

  const parsed = useMemo(() => parseAddresses(text), [text])
  // Send-level failures render as an alert below; the field carries only
  // its own validation.
  const sendLevelError = error !== null && SEND_ERRORS.has(error)
  const fieldError = sendLevelError ? null : error
  const total = parsed.valid.length + parsed.invalid.length

  // §10: the counter is a polite live region, debounced 500 ms.
  const [counted, setCounted] = useState(parsed)
  useEffect(() => {
    const timer = window.setTimeout(() => setCounted(parsed), 500)
    return () => window.clearTimeout(timer)
  }, [parsed])

  function removeAddress(address: string) {
    setText([...parsed.valid, ...parsed.invalid].filter((entry) => entry !== address).join('\n'))
  }

  async function send() {
    // This synchronous slot precedes every external call. React loading state
    // cannot arbitrate a rapid submit or a synchronous analytics reentry.
    if (flight.current !== null) return
    const current = context.current
    const owner = authOwner(authAdapter.getSnapshot())
    if (
      !current?.live ||
      current.organisationId !== organisationId ||
      current.callerRole !== callerRole ||
      owner === null
    )
      return
    const payload = JSON.stringify([parsed.valid, role])
    if (fallback.current?.context === current && fallback.current.payload === payload) return
    const invocation: Invocation = {
      context: current,
      epoch: current.epoch,
      owner,
      intention: null,
      submissionAttempted: false,
      resultAttempted: false,
      toastAttempted: false,
      callbackAttempted: false,
    }
    flight.current = invocation
    try {
      setError(null)
      if (total === 0) return setError('console.people.invite.error-emails-required')
      if (total > MAX_ADDRESSES)
        return setError(
          offers('member-import')
            ? 'console.people.invite.error-too-many'
            : 'console.people.invite.error-too-many-batches'
        )
      if (!clearInvitation()) return setError('console.people.invite.error-send-failed')
      if (!owns(invocation)) return
      recoveryEligible.current = false
      const local: Rejection[] = parsed.invalid.map((email) => ({
        email,
        outcome: 'invalid_email',
      }))
      if (parsed.valid.length === 0) {
        setResult({ sent: 0, rejected: local })
        return
      }
      if (attempt.current?.context !== current || attempt.current.payload !== payload) {
        attempt.current = {
          context: current,
          payload,
          key: crypto.randomUUID(),
          rows: Object.freeze(parsed.valid.map((email) => Object.freeze({ email, role }))),
          receipt: null,
        }
      }
      const intention = attempt.current
      invocation.intention = intention
      fallback.current = null
      setBlockedPayload(null)
      setSending(true)
      invocation.submissionAttempted = true
      trackInviteSubmitted(intention.rows.length, role, pasted)
      if (!owns(invocation)) return
      const value: unknown = await inviteBatch(
        organisationId,
        intention.rows.map((row) => ({ ...row })),
        intention.key
      )
      if (!owns(invocation)) return
      const receipt = consumedBatch(value, intention.rows)
      // Commit the consumed receipt BEFORE any reentrant analytics, cache,
      // toast or callback. An exception later cannot turn it into unknown POST.
      intention.receipt = receipt
      if (attempt.current === intention) attempt.current = null
      if (!owns(invocation)) return
      await invalidate()
      if (!owns(invocation)) return
      const rejected: Rejection[] = [
        ...receipt.results.flatMap((row) =>
          row.outcome === 'created' ? [] : [{ email: row.email, outcome: row.outcome }]
        ),
        ...local,
      ]
      invocation.resultAttempted = true
      trackInviteResult(
        receipt.created,
        rejected.length,
        rejected.map((row) => row.outcome)
      )
      if (!owns(invocation)) return
      if (rejected.length === 0) {
        invocation.toastAttempted = true
        notify({
          kind: 'success',
          title: t('console.people.invite.toast-sent', { count: receipt.created }),
        })
        if (!owns(invocation)) return
        invocation.callbackAttempted = true
        onSent(receipt.created)
        if (!owns(invocation)) return
        return
      }
      setResult({ sent: receipt.created, rejected })
      setText(
        rejected
          .filter((row) => RETRYABLE.has(row.outcome))
          .map((row) => row.email)
          .join('\n')
      )
      setBlurred(false)
    } catch (failure) {
      if (!owns(invocation)) return
      if (invocation.intention?.receipt !== null && invocation.intention?.receipt !== undefined) {
        fallback.current = invocation.intention
        setBlockedPayload(invocation.intention.payload)
        setResult(null)
        setError('console.people.invite.error-result-finalization')
      } else setError(beforeReceiptFailure(failure))
    } finally {
      if (owns(invocation)) {
        setSending(false)
        flight.current = null
      }
    }
  }

  const retrying = result !== null
  const sendLabel = retrying
    ? t('console.people.invite.action-retry-failed', { count: parsed.valid.length })
    : t('console.people.invite.action-send', { count: parsed.valid.length })

  return (
    <Drawer
      open
      onOpenChange={(open) => (open ? undefined : dismiss())}
      title={t('console.people.invite.title')}
      closeLabel={t('console.common.action-close')}
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <Button
            loading={sending}
            disabled={!online || blockedPayload === JSON.stringify([parsed.valid, role])}
            onClick={() => void send()}
          >
            {sendLabel}
          </Button>
          <Button variant="secondary" onClick={dismiss}>
            {t('console.common.action-cancel')}
          </Button>
          {online ? null : (
            <span className="text-xs text-c-ink-3">{t('console.common.error-offline')}</span>
          )}
        </div>
      }
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {result === null ? null : (
          <section
            aria-labelledby={resultId}
            className="flex flex-col gap-2 rounded-md border border-c-border p-4"
          >
            <h3 id={resultId} className="text-md font-semibold text-c-ink">
              {t('console.people.invite.title-partial', {
                sent: result.sent,
                failed: result.rejected.length,
              })}
            </h3>
            <ul className="flex flex-col gap-1 text-sm">
              {result.rejected.map((row) => (
                <li key={`${row.email}-${row.outcome}`} className="flex flex-wrap gap-2">
                  <span className="font-mono text-c-ink">{row.email}</span>
                  <span className="text-c-ink-2">{t(OUTCOME_COPY[row.outcome])}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId} className="text-sm font-medium text-c-ink">
            {t('console.people.invite.label-emails')}
          </label>
          <textarea
            id={fieldId}
            rows={4}
            value={text}
            aria-invalid={fieldError === null ? undefined : true}
            aria-describedby={cx(helpId, counterId, fieldError === null ? undefined : errorId)}
            onPaste={() => setPasted(true)}
            onChange={(event) => {
              setText(event.target.value)
              setBlurred(false)
            }}
            onBlur={() => setBlurred(true)}
            className={cx(
              'rounded-sm border bg-c-surface px-3 py-2 text-md text-c-ink outline-hidden',
              'focus-visible:ring',
              fieldError === null
                ? 'border-c-border-input focus:border-c-accent-ink'
                : 'border-c-bad-ink'
            )}
          />
          <p id={helpId} className="text-xs text-c-ink-3">
            {t('console.people.invite.hint-emails')} {t('console.people.invite.hint-validity')}
          </p>
          <p id={counterId} aria-live="polite" className="text-xs text-c-ink-2">
            {t('console.people.invite.status-counts', {
              valid: counted.valid.length,
              duplicates: counted.duplicates,
              invalid: counted.invalid.length,
            })}
          </p>
          {fieldError === null ? null : (
            <p id={errorId} className="text-xs text-c-bad-ink">
              {t(fieldError)}
            </p>
          )}
          {blurred && total > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {[...parsed.valid, ...parsed.invalid].map((address) => {
                const invalid = parsed.invalid.includes(address)
                return (
                  <li key={address}>
                    <button
                      type="button"
                      aria-label={t('console.people.invite.a11y-remove-address', { address })}
                      onClick={() => removeAddress(address)}
                      onKeyDown={(event) => {
                        if (event.key === 'Backspace' || event.key === 'Delete') {
                          event.preventDefault()
                          removeAddress(address)
                        }
                      }}
                      className={cx(
                        'inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-sm',
                        'focus-visible:ring focus-visible:outline-hidden',
                        invalid
                          ? 'border-c-bad bg-c-bad-soft text-c-bad-ink'
                          : 'border-c-border bg-c-muted text-c-ink'
                      )}
                    >
                      {address}
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {blurred && parsed.duplicates > 0 ? (
            <p className="text-xs text-c-ink-2">
              {t('console.people.invite.hint-duplicates', { count: parsed.duplicates })}
            </p>
          ) : null}
        </div>

        <RadioGroup
          label={t('console.people.invite.label-role')}
          value={role}
          onValueChange={(value) => setRole(value as InvitationRole)}
          options={invitableRoles(callerRole).map((value) => ({
            value,
            label: t(ROLE_OPTION[value]),
          }))}
        />
        {sendLevelError && error !== null ? (
          <div className="flex flex-col items-start gap-2">
            <InlineAlert kind="error">{t(error)}</InlineAlert>
            {error === 'console.people.invite.error-seat-limit' ? (
              <LinkButton href={`mailto:${SUPPORT_EMAIL}`} variant="tertiary">
                {t('console.common.action-contact-support')}
              </LinkButton>
            ) : null}
          </div>
        ) : null}
      </form>
    </Drawer>
  )
}
