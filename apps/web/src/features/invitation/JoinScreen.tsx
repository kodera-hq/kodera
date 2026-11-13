// `/join#code`: a workspace invite link (docs/specs/messaging-media-and-notifications.md). The
// person is signed in to Kodera already; the screen previews where the link leads and joins only on
// an explicit click. The code is read once from the fragment and kept in memory (`joinCode.ts`).

import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { LINK_TEXT } from '../../ui/linkText'
import { Spinner } from '../../ui/Spinner/Spinner'
import { takeJoinCode } from './joinCode'

type Preview = components['schemas']['WorkspaceInvitePreview']

type Phase =
  | { name: 'checking' }
  | { name: 'ready'; preview: Preview }
  | { name: 'joining'; preview: Preview }
  | { name: 'joined'; preview: Preview }
  | { name: 'missing' | 'sign-in' | 'gone' | 'failed' }

function refusal(error: unknown): Phase {
  if (error instanceof ApiProblem) {
    if (error.status === 401) return { name: 'sign-in' }
    if (error.status === 404 || error.status === 410) return { name: 'gone' }
  }
  return { name: 'failed' }
}

function preview(code: string): Promise<Preview> {
  return mutate(
    { method: 'post', path: '/workspace-invites/preview' },
    { params: { header: { 'Idempotency-Key': crypto.randomUUID() } }, body: { code } }
  )
}

export default function JoinScreen() {
  const { t, i18n } = useTranslation()
  const [code] = useState(() => takeJoinCode())
  const [phase, setPhase] = useState<Phase>(() =>
    code === null ? { name: 'missing' } : { name: 'checking' }
  )
  // One key for this page's joins: a retry after a lost answer cannot join twice.
  const [joinKey] = useState(() => crypto.randomUUID())
  useEffect(() => {
    if (code === null) return
    let live = true
    preview(code).then(
      (found) => live && setPhase({ name: 'ready', preview: found }),
      (error: unknown) => live && setPhase(refusal(error))
    )
    return () => {
      live = false
    }
  }, [code])

  function join(found: Preview) {
    if (code === null) return
    setPhase({ name: 'joining', preview: found })
    void mutate(
      { method: 'post', path: '/workspace-invites/redeem' },
      { params: { header: { 'Idempotency-Key': joinKey } }, body: { code } }
    ).then(
      () => setPhase({ name: 'joined', preview: found }),
      (error: unknown) => setPhase(refusal(error))
    )
  }

  const date = (iso: string) =>
    new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'long' }).format(new Date(iso))

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-[480px]">
        <CardBody>
          <div className="flex flex-col gap-4" aria-live="polite">
            <h1 className="text-xl font-semibold text-c-ink">
              {t('console.invitation.join.title')}
            </h1>
            {phase.name === 'checking' ? (
              <div className="flex items-center gap-2 text-sm text-c-ink-2">
                <Spinner />
                {t('console.invitation.join.checking')}
              </div>
            ) : null}
            {phase.name === 'ready' || phase.name === 'joining' ? (
              <>
                <p className="text-sm text-c-ink">
                  {t('console.invitation.join.ready', {
                    name: phase.preview.organisationName,
                    date: date(phase.preview.expiresAt),
                  })}
                </p>
                <p className="text-sm text-c-ink-2">
                  {phase.preview.role === 'moderator'
                    ? t('console.invitation.join.role-moderator')
                    : t('console.invitation.join.role-member')}
                </p>
                <div>
                  <Button
                    variant="primary"
                    disabled={phase.name === 'joining'}
                    onClick={() => join(phase.preview)}
                  >
                    {t('console.invitation.join.action-join', {
                      name: phase.preview.organisationName,
                    })}
                  </Button>
                </div>
              </>
            ) : null}
            {phase.name === 'joined' ? (
              <>
                <p className="text-sm text-c-ink">
                  {t('console.invitation.join.joined', { name: phase.preview.organisationName })}
                </p>
                <Link to="/" className={`text-sm font-medium ${LINK_TEXT.inline}`}>
                  {t('console.invitation.join.action-home')}
                </Link>
              </>
            ) : null}
            {phase.name === 'missing' ||
            phase.name === 'sign-in' ||
            phase.name === 'gone' ||
            phase.name === 'failed' ? (
              <p className="text-sm text-c-ink">
                {
                  {
                    missing: t('console.invitation.join.missing'),
                    'sign-in': t('console.invitation.join.sign-in'),
                    gone: t('console.invitation.join.gone'),
                    failed: t('console.invitation.join.failed'),
                  }[phase.name]
                }
              </p>
            ) : null}
          </div>
        </CardBody>
      </Card>
    </main>
  )
}
