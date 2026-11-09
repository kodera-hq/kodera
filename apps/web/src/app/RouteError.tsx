// What a customer sees when a route fails to load (docs/specs/00-shell-and-login.md
// §5, `shell` Error row: "`GET /me` fails → full-page error with retry and
// support"). Without it the router falls back to its own boundary, which
// prints an English "Something went wrong!" and the raw problem URI.
//
// Where it applies: the root route and the `/$org` layout declare it, and the
// router uses it as the default for every other route — `/`, `/login`, and
// every route below the organisation. It draws itself as a
// whole page (its own `main`, full height) unless the organisation's shell is
// on screen around it, in which case it fills the shell's content area.
//
// Three outcomes, switched on the problem `type` and never on its English
// `title` (§9):
//
// - `identity-unknown` (a 403, contract 0.28.0) means the token verified but
//   Core knows no enabled identity for it — a realm account nobody has added
//   to an organisation yet (Core `docs/api/AUTHZ.md` §2, step 6). Signing in
//   again yields the same token and the same answer, so this is never the
//   re-authentication screen and never the generic error: it says the person
//   is signed in, that an owner of their organisation must add them, and
//   offers signing out and support. Matched on its type alone: every other
//   403 (`forbidden`, `mfa-required`, an unregistered type) still reaches the
//   generic screen as before.
// - `unauthenticated` (a 401) means the session was not recognized: « Se reconnecter »
//   runs the same round trip as the expiry dialog, destination kept. With no
//   organisation in the URL it goes to `/login`. If the page fails with a 401
//   again right after that round trip, the screen offers signing out and
//   support instead of another round (`./reauthenticationMarker.ts`).
// - anything else is the console's own French error screen: retry, and the
//   support address. The request reference is shown for a server error only,
//   because that is when support can do something with it (§9). A problem
//   type outside the pinned registry reads as `null` (`../api/client.ts`) and
//   lands here too.
//
// The heading takes focus when the screen appears, and the message is an
// `alert`, so a screen-reader user hears what happened without hunting for it.

import { useMatches, useParams, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../api/client'
import type { ProblemType } from '../api/generated/problems'
import { useAuth } from '../auth/AuthProvider'
import { useReauthenticate } from '../auth/sessionExpiry'
import { Button } from '../ui/Button/Button'
import { LinkButton } from '../ui/LinkButton/LinkButton'
import {
  clearReauthenticationFromError,
  markReauthenticationFromError,
  reauthenticationFromErrorPending,
} from './reauthenticationMarker'
import { SUPPORT_EMAIL } from './supportContact'

const UNAUTHENTICATED = 'https://kodera.io/problems/unauthenticated'
/** Typed against the generated registry, so a contract that dropped the type
 * fails the typecheck here instead of leaving a branch nothing can reach. */
const IDENTITY_UNKNOWN: ProblemType = 'https://kodera.io/problems/identity-unknown'

/** `orgRoute`'s id, spelled rather than imported: `org-route.tsx` imports
 * this module, and the id is all the layout choice needs. */
const ORG_ROUTE_ID = '/$org'

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiProblem && (error.type === UNAUTHENTICATED || error.status === 401)
}

/** A verified token whose identity Core does not know, or has disabled: the
 * person is signed in but belongs to no organisation yet. Never a 401. */
export function isIdentityUnknown(error: unknown): boolean {
  return error instanceof ApiProblem && error.type === IDENTITY_UNKNOWN
}

function serverRequestId(error: unknown): string | undefined {
  return error instanceof ApiProblem && error.status >= 500 ? error.requestId : undefined
}

function Message({ title, body }: { title: string; body: string }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [title])
  return (
    <div role="alert" className="flex flex-col items-center gap-2">
      <h1 ref={heading} tabIndex={-1} className="text-lg font-semibold text-c-ink outline-hidden">
        {title}
      </h1>
      <p className="max-w-[420px] text-sm text-c-ink-3">{body}</p>
    </div>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-center gap-3">{children}</div>
}

function ContactSupport() {
  const { t } = useTranslation()
  return (
    <LinkButton variant="secondary" href={`mailto:${SUPPORT_EMAIL}`}>
      {t('console.common.action-contact-support')}
    </LinkButton>
  )
}

function SessionExpiredContent() {
  const { t } = useTranslation()
  const auth = useAuth()
  const router = useRouter()
  const reauthenticate = useReauthenticate()
  const params = useParams({ strict: false })
  const org = typeof params.org === 'string' ? params.org : undefined
  // Read once: the answer is about how this screen was reached.
  const [restoreFailed] = useState(reauthenticationFromErrorPending)

  if (restoreFailed) {
    return (
      <>
        <Message
          title={t('console.shell.session.title-restore-failed')}
          body={t('console.shell.session.body-restore-failed', { email: SUPPORT_EMAIL })}
        />
        <Actions>
          <Button
            onClick={() => {
              clearReauthenticationFromError()
              void auth
                .signOut()
                .catch(() => {})
                .then(() => router.navigate({ to: '/login' }))
            }}
          >
            {t('console.shell.session.action-sign-out')}
          </Button>
          <ContactSupport />
        </Actions>
      </>
    )
  }

  return (
    <>
      <Message
        title={t('console.shell.session.title-unrecognized')}
        body={t('console.shell.session.body-unrecognized')}
      />
      <Actions>
        <Button
          onClick={() => {
            if (org !== undefined) {
              markReauthenticationFromError()
              if (reauthenticate(org)) return
              clearReauthenticationFromError()
            }
            void router.navigate({ to: '/login' })
          }}
        >
          {t('console.shell.session.action-sign-in-again')}
        </Button>
      </Actions>
    </>
  )
}

function NoOrganisationContent() {
  const { t } = useTranslation()
  const auth = useAuth()
  const router = useRouter()
  return (
    <>
      <Message
        title={t('console.shell.session.title-no-organisation')}
        body={t('console.shell.session.body-no-organisation')}
      />
      <Actions>
        <Button
          onClick={() => {
            // Sign-out is local today: it drops this browser's tokens and
            // session keys (the loop marker included) and goes to `/login`,
            // but it does not end the identity provider's session, so it
            // does not by itself lead to another account. The person's next
            // step is to ask an owner of the organisation to add them, or to
            // write to support; signing in again would bring the same answer.
            void auth
              .signOut()
              .catch(() => {})
              .then(() => router.navigate({ to: '/login' }))
          }}
        >
          {t('console.shell.session.action-sign-out')}
        </Button>
        <ContactSupport />
      </Actions>
    </>
  )
}

function LoadFailedContent({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const requestId = serverRequestId(error)
  return (
    <>
      <Message
        title={t('console.shell._.title-load-failed')}
        body={t('console.shell._.body-load-failed', { email: SUPPORT_EMAIL })}
      />
      {requestId === undefined ? null : (
        <p className="font-mono text-xs text-c-ink-3">
          {t('console.common.label-request-reference', { requestId })}
        </p>
      )}
      <Actions>
        <Button
          onClick={() => {
            // `invalidate` re-runs the failed loader; `reset` clears the
            // boundary so a render error gets its second try as well.
            reset()
            void router.invalidate()
          }}
        >
          {t('console.common.action-retry')}
        </Button>
        <ContactSupport />
      </Actions>
    </>
  )
}

export function RouteError(props: ErrorComponentProps) {
  // The shell is on screen only when the organisation layout itself loaded;
  // its own failure, and every route outside it, get the whole page.
  const inShell = useMatches({
    select: (matches) =>
      matches.some((match) => match.routeId === ORG_ROUTE_ID && match.status === 'success'),
  })
  const content = isIdentityUnknown(props.error) ? (
    <NoOrganisationContent />
  ) : isUnauthenticated(props.error) ? (
    <SessionExpiredContent />
  ) : (
    <LoadFailedContent {...props} />
  )
  return inShell ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12 text-center">
      {content}
    </div>
  ) : (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      {content}
    </main>
  )
}
