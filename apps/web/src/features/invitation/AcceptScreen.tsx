// An invitation's acceptance (docs/specs/12-invitation-accept.md). Before any sign-in, the
// organisation the link names is discovered by its slug and must be the one its path names; the
// person then signs in to that organisation's realm in the protected popup, and accepts with one
// explicit click. The secret stays in memory (`entry.ts`) and is posted once per sign-in, under one
// idempotency key that a retry reuses.

import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem, coreApi } from '../../api/client'
import type { ProtectedAuthOperation } from '../../auth/AuthAdapter'
import { mutate } from '../../api/mutations'
import type { Landing } from '../../app/landing'
import { landingIn } from '../../app/organisationLanding'
import { authAdapter } from '../../auth/oidc'
import type { MessageKey } from '../../i18n'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { Spinner } from '../../ui/Spinner/Spinner'
import { forgetInvitationEntry, forgetInvitationEntryIfHeld, readInvitationEntry } from './entry'
import type { InvitationEntry } from './entry'

type Phase =
  | 'checking'
  | 'busy'
  | 'sign-in'
  | 'signing-in'
  | 'ready'
  | 'retry'
  | 'check-retry'
  | 'member'
  | 'unusable'
  | 'missing'
  | 'invalid'
  | 'unknown'
  | 'gone'
  | 'failed'

/** Each settled phase's one sentence; `sign-in`, `ready`, `retry` and `member` name the organisation. */
const MESSAGE: Record<Exclude<Phase, 'checking' | 'busy'>, MessageKey> = {
  'sign-in': 'console.invitation.accept.sign-in',
  'signing-in': 'console.invitation.accept.signing-in',
  ready: 'console.invitation.accept.ready',
  retry: 'console.invitation.accept.retry',
  'check-retry': 'console.invitation.accept.check-retry',
  member: 'console.invitation.accept.member',
  unusable: 'console.invitation.accept.unusable',
  missing: 'console.invitation.accept.missing',
  invalid: 'console.invitation.accept.invalid',
  unknown: 'console.invitation.accept.unknown',
  gone: 'console.invitation.accept.gone',
  failed: 'console.invitation.accept.failed',
}

/** The organisation discovery answered for the link's slug, once it matched the link's id. */
interface Discovered {
  readonly realm: string
  readonly name: string
}

const problem = (suffix: string) => `https://kodera.io/problems/${suffix}`

/** §5: an answer the person can act on; anything else is `failed`, never « réessayez ». */
function refusal(error: ApiProblem): Phase {
  if (error.status === 404) return 'unknown'
  if (error.status === 410) return 'gone'
  // A 409 is three different answers. The domain `conflict` may say the person is a member, and
  // `accept()` confirms that before saying so; `idempotency-key-in-flight` says the first request,
  // under this key, is still running, and its outcome is unknown.
  if (error.status === 409 && error.type === problem('conflict')) return 'member'
  if (error.status === 409 && error.type === problem('idempotency-key-in-flight')) return 'retry'
  if (error.status === 401) return 'sign-in'
  if (error.status === 429 || error.status >= 500) return 'retry'
  return 'failed'
}

/** Discovery that got no answer, or a busy or failing one, may be asked again; a refusal may not. */
function discoveryRetries(error: unknown): boolean {
  return !(error instanceof ApiProblem) || error.status === 429 || error.status >= 500
}

export function AcceptScreen({
  organisationId,
  organisationSlug,
}: {
  organisationId: string
  organisationSlug: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<Phase>(() =>
    readInvitationEntry(organisationId, organisationSlug) === undefined ? 'missing' : 'checking'
  )
  const [discovered, setDiscovered] = useState<Discovered | undefined>(undefined)
  /** One logical acceptance per sign-in: a retry resends this key with the same body. */
  const idempotencyKey = useRef<string | undefined>(undefined)
  /** The session the protected sign-in produced; an acceptance is sent only under it. */
  const signedInGeneration = useRef<number | undefined>(undefined)
  const pendingSignIn = useRef<ProtectedAuthOperation | undefined>(undefined)
  const mounted = useRef(false)
  /** The entry this page opened with: the one leaving it forgets. */
  const opened = useRef(readInvitationEntry(organisationId, organisationSlug))
  /** Where the member's « Ouvrir » leads: Espace for a member, Home for the others. */
  const [landing, setLanding] = useState<Landing>('/$org/home')
  /** Until when the acceptance waits, after `idempotency-key-in-flight`'s `retry_after_s`. */
  const [retryAt, setRetryAt] = useState<number | undefined>(undefined)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (phase !== 'busy' && phase !== 'checking') heading.current?.focus()
  }, [phase])

  // The secret does not outlive the page: leaving it, even into the back-forward cache, ends it.
  useEffect(() => {
    window.addEventListener('pagehide', forgetInvitationEntry)
    return () => window.removeEventListener('pagehide', forgetInvitationEntry)
  }, [])

  // Leaving the route inside the app (the home link, back) ends the page as `pagehide` does: the
  // secret is forgotten and a sign-in still open is cancelled. StrictMode's rehearsal unmount is
  // followed at once by a mount, so only an unmount still standing after this task counts.
  useEffect(() => {
    mounted.current = true
    const own = opened.current
    return () => {
      mounted.current = false
      window.setTimeout(() => {
        if (mounted.current) return
        pendingSignIn.current?.cancel()
        pendingSignIn.current = undefined
        if (own !== undefined) forgetInvitationEntryIfHeld(own)
      }, 0)
    }
  }, [])

  useEffect(() => {
    if (retryAt === undefined) return
    const timer = window.setTimeout(() => setRetryAt(undefined), Math.max(0, retryAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [retryAt])

  function end(next: Phase) {
    idempotencyKey.current = undefined
    forgetInvitationEntry()
    setPhase(next)
  }

  /** The entry, read at the moment of acting: a page restored without it says so. */
  function heldEntry(): InvitationEntry | undefined {
    const entry = readInvitationEntry(organisationId, organisationSlug)
    if (entry === undefined) setPhase('missing')
    return entry
  }

  // §4.1: the slug's organisation must be the path's before anything is offered. A link whose two
  // halves disagree is refused here, and no sign-in starts.
  useEffect(() => {
    if (phase !== 'checking') return
    let live = true
    mutate({ method: 'post', path: '/auth/discover' }, { body: { slug: organisationSlug } })
      .then((answer) => {
        if (!live) return
        const organisation = answer.organisation
        if (
          organisation === null ||
          answer.realm === null ||
          organisation.id !== organisationId ||
          organisation.slug !== organisationSlug ||
          organisation.realm !== answer.realm
        )
          return end('invalid')
        setDiscovered({ realm: answer.realm, name: organisation.name })
        setPhase('sign-in')
      })
      .catch((error: unknown) => {
        if (!live) return
        if (discoveryRetries(error)) return setPhase('check-retry')
        end('failed')
      })
    return () => {
      live = false
    }
  }, [phase, organisationId, organisationSlug])

  async function signIn() {
    const entry = heldEntry()
    const protectedAuth = authAdapter.ownerClaimAuth
    if (entry === undefined || discovered === undefined) return
    if (protectedAuth === undefined) return end('failed')
    setPhase('signing-in')
    // A new sign-in is a new session, and a new logical acceptance.
    idempotencyKey.current = undefined
    signedInGeneration.current = undefined
    const operation = protectedAuth.begin({
      purpose: 'invitation',
      intentId: crypto.randomUUID(),
      organisationId: entry.organisationId,
      organisationSlug: entry.organisationSlug,
      realm: discovered.realm,
    })
    pendingSignIn.current = operation
    try {
      await operation.completed
    } catch {
      // A closed popup: the person may sign in again. One the person cancelled has said so already.
      if (pendingSignIn.current === operation) setPhase('sign-in')
      return
    } finally {
      if (pendingSignIn.current === operation) pendingSignIn.current = undefined
    }
    signedInGeneration.current = authAdapter.getSnapshot().generation
    setPhase('ready')
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

  /** Core's `conflict` also answers an organisation that is not active and a person removed from
   * it: only `/me`, read under the session that accepted, says whether the home will open. */
  async function memberHere(): Promise<boolean> {
    const generation = signedInGeneration.current
    try {
      const { data } = await coreApi().GET('/me')
      if (authAdapter.getSnapshot().generation !== generation) return false
      const membership = (data?.organisations ?? []).find(
        (entry) => entry.organisation.id === organisationId && entry.state === 'active'
      )
      if (membership === undefined) return false
      const to = await landingIn(organisationId, membership.role)
      if (authAdapter.getSnapshot().generation !== generation) return false
      setLanding(to)
      return true
    } catch {
      return false
    }
  }

  async function accept() {
    const entry = heldEntry()
    if (entry === undefined) return
    const session = authAdapter.getSnapshot()
    if (session.status !== 'ready' || session.generation !== signedInGeneration.current) {
      // Not the session this page's sign-in produced: nothing is sent, and the next sign-in
      // starts a new acceptance.
      idempotencyKey.current = undefined
      signedInGeneration.current = undefined
      return setPhase('sign-in')
    }
    idempotencyKey.current ??= crypto.randomUUID()
    setPhase('busy')
    let membership: { role?: Parameters<typeof landingIn>[1] }
    try {
      membership = await mutate(
        { method: 'post', path: '/invitations/accept' },
        {
          body: { token: entry.secret },
          params: { header: { 'Idempotency-Key': idempotencyKey.current } },
        }
      )
    } catch (error) {
      if (!(error instanceof ApiProblem)) return setPhase('retry')
      const next = refusal(error)
      if (next === 'retry') {
        // The key's own contract text asks for a new key after any `4xx`. Core stores no `429`
        // against its key (CONVENTIONS §8), so the new key changes nothing on the wire.
        if (error.status === 429) idempotencyKey.current = undefined
        // The first request is still running: same key and body, once its wait has passed.
        if (error.type === problem('idempotency-key-in-flight'))
          setRetryAt(Date.now() + Math.max(1, error.retryAfterS ?? 1) * 1000)
        return setPhase('retry')
      }
      if (next === 'sign-in') {
        idempotencyKey.current = undefined
        return setPhase('sign-in')
      }
      if (next === 'member') {
        setPhase('busy')
        return end((await memberHere()) ? 'member' : 'unusable')
      }
      return end(next)
    }
    end('busy')
    // The membership is new: no `/me` read before it may answer for this person now.
    queryClient.removeQueries({ queryKey: ['me'] })
    void navigate({
      to: await landingIn(organisationId, membership.role),
      params: { org: organisationSlug },
    })
  }

  const name = discovered?.name ?? ''
  return (
    <main className="flex min-h-screen items-center justify-center p-6 narrow:p-4">
      <Card className="w-full max-w-[480px]">
        <CardBody className="flex flex-col gap-4">
          <p className="text-md font-semibold text-c-accent-ink">
            {t('console.invitation.accept.eyebrow')}
          </p>
          {/* The organisation, once discovery has confirmed it is the link's own (§4.1): its name
              comes from that answer, never from the link. */}
          {discovered === undefined ? null : (
            <div className="flex items-center gap-3 border-b border-c-border-soft pb-4">
              <Avatar name={name} variant="admin" aria-hidden="true" />
              <p className="min-w-0 truncate text-md font-semibold text-c-ink">{name}</p>
            </div>
          )}
          {/* The spinner is its own live status; each settled state is announced by moving
              focus to its heading, which is where reading resumes, not a control: as a route
              heading it draws no focus ring (src/index.css, `[data-route-heading]`). */}
          {phase === 'busy' || phase === 'checking' ? (
            <Spinner size="lg" label={t('console.invitation.accept.busy')} />
          ) : (
            <h1
              ref={heading}
              tabIndex={-1}
              data-route-heading=""
              className="text-2xl leading-tight font-bold text-c-ink"
            >
              {t(MESSAGE[phase], { name })}
            </h1>
          )}
          {phase === 'sign-in' ? (
            <Button onClick={() => void signIn()}>
              {t('console.invitation.accept.action-sign-in')}
            </Button>
          ) : null}
          {phase === 'signing-in' ? (
            <Button variant="secondary" onClick={cancelSignIn}>
              {t('console.invitation.accept.action-cancel')}
            </Button>
          ) : null}
          {phase === 'check-retry' ? (
            <Button onClick={() => setPhase('checking')}>
              {t('console.invitation.accept.action-retry')}
            </Button>
          ) : null}
          {phase === 'ready' || phase === 'retry' ? (
            <Button disabled={retryAt !== undefined} onClick={() => void accept()}>
              {t('console.invitation.accept.action-accept', { name })}
            </Button>
          ) : null}
          {phase === 'member' ? (
            <Button asChild>
              <Link to={landing} params={{ org: organisationSlug }}>
                {t(
                  landing === '/$org/workspace'
                    ? 'console.invitation.accept.action-open-workspace'
                    : 'console.invitation.accept.action-open'
                )}
              </Link>
            </Button>
          ) : null}
        </CardBody>
      </Card>
    </main>
  )
}
