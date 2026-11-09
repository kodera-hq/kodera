// The first-owner claim (docs/specs/09-owner-claim.md), composed from the pieces already in
// place: the protected popup sign-in (`ownerClaimAuth`), the bootstrap read, one explicit
// confirm through `dispatchOwnerClaim` under `createClaimAttempt`'s retry rules, and a fresh
// `/me` that must show `org_owner` before the person is sent on to Order, where the CGV and
// DPA are accepted before any workspace exists.
// Nothing is posted without the confirm, and the claim itself accepts no terms (§6).

import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem, coreApi, dispatchOwnerClaim } from '../../api/client'
import type { ProtectedAuthOperation } from '../../auth/AuthAdapter'
import { authAdapter } from '../../auth/oidc'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { Spinner } from '../../ui/Spinner/Spinner'
import { createClaimAttempt } from './claimAttempt'
import type { ClaimAttemptContext, ClaimAttemptOutcome } from './claimAttempt'
import { forgetClaimEntry, readClaimEntry } from './entry'
import type { ClaimEntry } from './entry'
import { loadFreshClaimOwner } from './freshOwner'

type Phase =
  | 'sign-in'
  | 'signing-in'
  | 'busy'
  | 'ready'
  | 'retry'
  | 'confirmed'
  | 'missing'
  | 'not-ready'
  | 'unknown'
  | 'expired'
  | 'revoked'
  | 'consumed'
  | 'mismatch'
  | 'mfa'
  | 'contact'
  | 'failed'

/** Each phase's one sentence; `sign-in`, `signing-in`, `ready`, `retry` and `confirmed` also
 * carry an action. */
const MESSAGE: Record<Exclude<Phase, 'busy'>, MessageKey> = {
  'sign-in': 'console.claim.landing.sign-in',
  'signing-in': 'console.claim.landing.signing-in',
  ready: 'console.claim.landing.ready',
  retry: 'console.claim.landing.retry',
  confirmed: 'console.claim.landing.confirmed',
  missing: 'console.claim.landing.missing',
  'not-ready': 'console.claim.landing.not-ready',
  unknown: 'console.claim.landing.unknown',
  expired: 'console.claim.landing.expired',
  revoked: 'console.claim.landing.revoked',
  consumed: 'console.claim.landing.consumed',
  mismatch: 'console.claim.landing.mismatch',
  mfa: 'console.claim.landing.mfa',
  contact: 'console.claim.landing.contact',
  failed: 'console.claim.landing.failed',
}

const problem = (suffix: string) => `https://kodera.io/problems/${suffix}`
/** Core accepts a login at most 320 s old, at its decision and again at its final read, so the
 * commit lands within 330 s while its read-to-commit lag stays within a 10 s target that is not
 * enforced; 300 s here leaves 20 s of margin under the 320 s. With `max_age=0` the sign-in popup's
 * return is the login, so the page times it on its own monotonic clock, never the device's wall
 * clock against the provider's `auth_time`. Advisory: Core's check is the authority. */
const RECENT_LOGIN_MS = 300_000
/** §5: what a refusal tells the person. Any other client error is `failed`, never « réessayez ». */
const REFUSED: Readonly<Record<string, Phase>> = {
  [problem('owner-claim-expired')]: 'expired',
  [problem('owner-claim-revoked')]: 'revoked',
  [problem('owner-claim-consumed')]: 'consumed',
  [problem('invalid-state-transition')]: 'consumed',
  [problem('owner-claim-identity-mismatch')]: 'mismatch',
  [problem('mfa-required')]: 'mfa',
  [problem('owner-claim-contact-unverified')]: 'contact',
  [problem('not-found')]: 'unknown',
}

type Attempt = ReturnType<typeof createClaimAttempt>

function currentContext(entry: ClaimEntry): ClaimAttemptContext | undefined {
  const session = authAdapter.getSnapshot()
  const identity = session.user?.identity
  const accessToken = authAdapter.getAccessToken()
  if (session.status !== 'ready' || identity === undefined || !accessToken) return undefined
  return {
    issuer: identity.issuer,
    subject: identity.subject,
    generation: session.generation,
    accessToken,
    organisationId: entry.organisationId,
    organisationSlug: entry.organisationSlug,
  }
}

/** A problem document is an answer; anything else — no network, an unreadable body, an abort —
 * leaves the outcome unknown, which the attempt retries with the same key and body. */
function outcomeOf(error: unknown): ClaimAttemptOutcome {
  if (error instanceof ApiProblem)
    return {
      kind: 'response',
      status: error.status,
      problem: { type: error.type, retryAfterS: error.retryAfterS },
    }
  return { kind: 'network' }
}

export function ClaimScreen({
  organisationId,
  organisationSlug,
}: {
  organisationId: string
  organisationSlug: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>(() =>
    readClaimEntry(organisationId, organisationSlug) === undefined ? 'missing' : 'sign-in'
  )
  const [retryAt, setRetryAt] = useState<number | undefined>(undefined)
  const attempt = useRef<Attempt | undefined>(undefined)
  const signedInAt = useRef<number | undefined>(undefined)
  /** The sign-in window still open, which the person may abandon from this page. */
  const pendingSignIn = useRef<ProtectedAuthOperation | undefined>(undefined)
  const heading = useRef<HTMLHeadingElement>(null)

  // Each state's sentence is the heading, and focus follows it (§12: keyboard-only path).
  useEffect(() => {
    if (phase !== 'busy') heading.current?.focus()
  }, [phase])

  // The secret does not outlive the page (§3): leaving it, even into the back-forward cache, ends it.
  useEffect(() => {
    window.addEventListener('pagehide', forgetClaimEntry)
    return () => window.removeEventListener('pagehide', forgetClaimEntry)
  }, [])

  // A 503 asks for one second; the confirm comes back when it has passed, not before.
  useEffect(() => {
    if (retryAt === undefined) return
    const timer = window.setTimeout(() => setRetryAt(undefined), Math.max(0, retryAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [retryAt])

  /** The entry, read at the moment of acting: a page restored without it says so. */
  function heldEntry(): ClaimEntry | undefined {
    const entry = readClaimEntry(organisationId, organisationSlug)
    if (entry === undefined) setPhase('missing')
    return entry
  }

  function end(next: Phase) {
    attempt.current = undefined
    forgetClaimEntry()
    setPhase(next)
  }

  async function signIn() {
    const claim = heldEntry()
    const claimAuth = authAdapter.ownerClaimAuth
    if (claim === undefined) return
    if (claimAuth === undefined) return end('failed')
    setPhase('signing-in')
    // A new sign-in is a new session: an attempt fenced to the previous one has nothing left to send.
    attempt.current = undefined
    signedInAt.current = undefined
    let operation: ProtectedAuthOperation | undefined
    try {
      operation = claimAuth.begin({
        purpose: 'owner-claim',
        intentId: crypto.randomUUID(),
        organisationId: claim.organisationId,
        organisationSlug: claim.organisationSlug,
        realm: claim.organisationSlug,
      })
      pendingSignIn.current = operation
      await operation.completed
      signedInAt.current = performance.now()
    } catch {
      // A closed popup: the person may sign in again. One the person cancelled has said so already.
      if (operation === undefined || pendingSignIn.current === operation) setPhase('sign-in')
      return
    } finally {
      if (pendingSignIn.current === operation) pendingSignIn.current = undefined
    }
    setPhase('busy')
    try {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/bootstrap', {
        params: { path: { organisation_id: claim.organisationId } },
      })
      if (data?.organisation_id !== claim.organisationId || data.slug !== claim.organisationSlug)
        return end('failed')
      const state = data.claim.state
      if (state === 'issued') return setPhase('ready')
      end(state === 'not_issued' ? 'not-ready' : state)
    } catch (error) {
      end(error instanceof ApiProblem ? (REFUSED[error.type ?? ''] ?? 'failed') : 'failed')
    }
  }

  /** The person gives up on the open window: it closes, and the page offers the sign-in again. */
  function cancelSignIn() {
    const operation = pendingSignIn.current
    pendingSignIn.current = undefined
    try {
      operation?.cancel()
    } catch {
      // The adapter has already dropped the sign-in; only its cleanup failed.
    }
    setPhase('sign-in')
  }

  async function confirm() {
    const claim = heldEntry()
    if (claim === undefined) return
    const context = currentContext(claim)
    if (context === undefined) return setPhase('sign-in')
    const since = signedInAt.current
    if (since === undefined || performance.now() - since >= RECENT_LOGIN_MS) {
      // Nothing is sent: as when dispatch does not start, a fresh sign-in starts a fresh attempt.
      attempt.current = undefined
      return setPhase('sign-in')
    }
    // One logical key per sign-in on this page: a deliberate retry resends the same key and
    // body, never a new one (ADR-0010).
    attempt.current ??= createClaimAttempt({
      idempotencyKey: crypto.randomUUID(),
      body: { token: claim.secret },
      context,
    })
    const owner = attempt.current
    const ticket = owner.begin(context, Date.now())
    if (ticket === undefined) {
      // Still inside the 503's wait, or fenced out by a changed session.
      return owner.snapshot().status === 'waiting' ? setPhase('retry') : end('failed')
    }
    setPhase('busy')
    const controller = new AbortController()
    let outcome: ClaimAttemptOutcome
    try {
      const dispatch = dispatchOwnerClaim({
        isCurrent: () => currentContext(claim)?.accessToken === context.accessToken,
        borrow: () => ({
          idempotencyKey: ticket.idempotencyKey,
          body: { ...ticket.body },
          expectedAccessToken: context.accessToken,
          signal: controller.signal,
        }),
        releaseBorrow: () => {},
      })
      if (dispatch.kind === 'not-started') {
        // Nothing was sent: a fresh sign-in may start a fresh attempt.
        attempt.current = undefined
        return setPhase('sign-in')
      }
      await dispatch.result
      outcome = { kind: 'response', status: 200 }
    } catch (error) {
      outcome = outcomeOf(error)
    }
    // The answer belongs to the request it answers, sent under `context`.
    owner.settle(ticket, context, outcome, Date.now())
    const { status, retryAt: waitUntil } = owner.snapshot()
    if (status === 'success-awaiting-owner-read') {
      attempt.current = undefined
      forgetClaimEntry()
      const confirmed = await loadFreshClaimOwner(
        {
          organisationId: claim.organisationId,
          organisationSlug: claim.organisationSlug,
          issuer: context.issuer,
          subject: context.subject,
          generation: context.generation,
        },
        controller.signal
      ).catch(() => undefined)
      if (confirmed === undefined) return setPhase('confirmed')
      return void navigate({ to: '/$org/order', params: { org: claim.organisationSlug } })
    }
    if (status === 'waiting') {
      setRetryAt(waitUntil)
      return setPhase('retry')
    }
    const refused = outcome.kind === 'response' ? REFUSED[outcome.problem?.type ?? ''] : undefined
    if (
      status === 'uncertain' &&
      refused === undefined &&
      (outcome.kind === 'network' || outcome.status >= 500)
    )
      return setPhase('retry')
    end(refused ?? 'failed')
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6 narrow:p-4">
      <Card className="w-full max-w-[480px]">
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-c-ink-3">{t('console.claim.landing.eyebrow')}</p>
          {/* The spinner is its own live status; each settled state is announced by moving
              focus to its heading. */}
          {phase === 'busy' ? (
            <Spinner size="lg" label={t('console.claim.landing.busy')} />
          ) : (
            <h1 ref={heading} tabIndex={-1} className="text-lg font-semibold text-c-ink">
              {t(MESSAGE[phase])}
            </h1>
          )}
          {phase === 'sign-in' ? (
            <Button onClick={() => void signIn()}>
              {t('console.claim.landing.action-sign-in')}
            </Button>
          ) : null}
          {phase === 'signing-in' ? (
            <Button variant="secondary" onClick={cancelSignIn}>
              {t('console.claim.landing.action-cancel')}
            </Button>
          ) : null}
          {phase === 'ready' || phase === 'retry' ? (
            <Button disabled={retryAt !== undefined} onClick={() => void confirm()}>
              {t('console.claim.landing.action-confirm')}
            </Button>
          ) : null}
          {phase === 'confirmed' ? (
            <Button asChild>
              <Link to="/$org/order" params={{ org: organisationSlug }}>
                {t('console.claim.landing.action-continue')}
              </Link>
            </Button>
          ) : null}
        </CardBody>
      </Card>
    </main>
  )
}
