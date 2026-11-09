// docs/specs/08-home.md §4.3, §6, §9: the pending-invitations banner. One
// `POST /invitations/{id}/actions/resend` per invitation — the design's
// bulk-resend endpoint does not exist — and the result is a partial-failure
// surface: successes drop from the count and are never re-attempted, a
// rate-limited address is listed with its own retry and countdown.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { components } from '../../api/schema'
import { ApiProblem } from '../../api/client'
import { mutate } from '../../api/mutations'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { useToast } from '../../ui/Toast/Toast'
import { summariseResend } from './invitations'
import type { ResendOutcome } from './invitations'
import { invitationsBucket, trackInvitationsBannerShown, trackInvitationsResent } from './analytics'

type Invitation = components['schemas']['Invitation']

export interface InvitationsBannerProps {
  /** Already filtered to pending invitations last sent more than 72 hours ago
   * (`invitationsPastTheirSetUpLink`) and already paged (§6: "au moins
   * {count}" when the page has more). `undefined` while loading. */
  invitations: Invitation[]
  hasMore: boolean
  errored?: boolean
  offline?: boolean
}

type AttemptOutcome = ResendOutcome & { completedAt: number }

async function resendOne(invitation: Invitation): Promise<AttemptOutcome> {
  try {
    await mutate(
      { method: 'post', path: '/invitations/{invitation_id}/actions/resend' },
      { params: { path: { invitation_id: invitation.id } } }
    )
    return { invitation, ok: true, completedAt: Date.now() }
  } catch (error) {
    if (
      error instanceof ApiProblem &&
      error.type === 'https://kodera.io/problems/rate-limited'
    ) {
      return { invitation, ok: false, retryAfterS: error.retryAfterS, completedAt: Date.now() }
    }
    return { invitation, ok: false, completedAt: Date.now() }
  }
}

export function InvitationsBanner({
  invitations,
  hasMore,
  errored = false,
  offline = false,
}: InvitationsBannerProps) {
  const { t } = useTranslation()
  const notify = useToast()
  const [succeeded, setSucceeded] = useState<Set<string>>(() => new Set())
  const [failures, setFailures] = useState<
    Map<string, { outcome: ResendOutcome; retryAt: number }>
  >(() => new Map())
  const [resending, setResending] = useState(false)
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Props remain authoritative for current eligible IDs; success suppression
  // belongs only to this person/organisation mount, never to a stale batch.
  const targets = invitations.filter((item) => item.state === 'pending' && !succeeded.has(item.id))
  const failed = targets.flatMap((item) => {
    const failure = failures.get(item.id)
    return failure === undefined
      ? []
      : [
          {
            ...failure.outcome,
            invitation: item,
            retryAfterS: Math.max(0, Math.ceil((failure.retryAt - now) / 1000)),
          },
        ]
  })
  const coolingDown = targets.some((item) => (failures.get(item.id)?.retryAt ?? 0) > now)
  useEffect(() => {
    if (!coolingDown) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [coolingDown])

  // Checked before the "nothing to show" guard below: the invitations call
  // failing is itself a reason to show something, even though it also
  // leaves `invitations` empty — the state matrix's own distinction between
  // "no pending invitation" (no banner) and "could not read them" (a quiet
  // note).
  if (errored) {
    return (
      <Banner kind="info" headline={t('console.home.overview.error-invitations-unavailable')} />
    )
  }

  if (targets.length === 0) {
    return null
  }

  const count = targets.length

  const handleResend = async () => {
    if (offline || inFlight.current) return
    const eligible = targets.filter((item) => (failures.get(item.id)?.retryAt ?? 0) <= Date.now())
    if (eligible.length === 0) return
    inFlight.current = true
    setResending(true)
    trackInvitationsBannerShown(invitationsBucket(count))
    const outcomes = await Promise.all(eligible.map(resendOne))
    inFlight.current = false
    if (!mounted.current) return
    const summary = summariseResend(outcomes)
    trackInvitationsResent(summary.attempted, summary.succeeded, summary.failed.length)
    setSucceeded(
      (previous) =>
        new Set([
          ...previous,
          ...outcomes.filter((item) => item.ok).map((item) => item.invitation.id),
        ])
    )
    const completedAt = Math.max(...outcomes.map((outcome) => outcome.completedAt))
    setNow(completedAt)
    setFailures((previous) => {
      const next = new Map(previous)
      for (const outcome of outcomes) {
        if (outcome.ok) next.delete(outcome.invitation.id)
        else
          next.set(outcome.invitation.id, {
            outcome,
            retryAt: outcome.completedAt + Math.max(0, outcome.retryAfterS ?? 0) * 1000,
          })
      }
      return next
    })
    setResending(false)
    if (summary.failed.length === 0) {
      notify({
        kind: 'success',
        title: t('console.home.overview.toast-invitations-resent', { count: summary.succeeded }),
      })
    }
  }

  const countLabelKey = hasMore
    ? 'console.home.overview.status-pending-invitations-partial'
    : 'console.home.overview.status-pending-invitations'

  // `Banner` carries no children slot (three lines: headline, detail,
  // action — COMPONENTS.md), so the partial-failure list of addresses,
  // which is more than a single detail line, is composed into the `action`
  // slot alongside the retry button rather than left off the banner.
  const action = (
    <div className="flex flex-col gap-3">
      {failed.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {failed.map((outcome) => (
            <li key={outcome.invitation.id} className="flex items-center gap-2 text-sm">
              <span className="font-mono">{outcome.invitation.email}</span>
              {outcome.retryAfterS > 0 ? (
                <span>
                  {t('console.common.error-rate-limited', { seconds: outcome.retryAfterS })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          loading={resending}
          disabled={offline || targets.every((item) => (failures.get(item.id)?.retryAt ?? 0) > now)}
          onClick={() => void handleResend()}
        >
          {t('console.home.overview.action-resend-invitations')}
        </Button>
        {offline ? (
          <span className="text-xs text-c-ink-3">{t('console.common.error-offline')}</span>
        ) : null}
      </div>
    </div>
  )

  return <Banner kind="info" headline={t(countLabelKey, { count })} action={action} />
}
