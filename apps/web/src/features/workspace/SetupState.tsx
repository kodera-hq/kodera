// What the workspace page says before the workspace exists (docs/specs/11-workspace.md §4.3):
// one heading, one sentence, at most one action. A change of state is announced by the screen's
// own live region (`WorkspaceScreen`), not here, so it is said once.

import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpLink } from '../support/HelpLink'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { initialiseWorkspace, workspaceQueryKey } from './queries'
import { isStaleRead, keyAfterFailure } from './workspace'
import type { MessageKey } from '../../i18n'

function freshKey(): string {
  return crypto.randomUUID()
}

interface BlockProps {
  /** The organisation the workspace belongs to: the one fact of context the page keeps while the
   * workspace, and its channel column, do not exist yet. */
  organisationName: string
  titleKey: MessageKey
  bodyKey: MessageKey
  children?: ReactNode
}

function Block({ organisationName, titleKey, bodyKey, children }: BlockProps) {
  const { t } = useTranslation()
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center narrow:px-0">
      <p className="text-sm font-semibold text-c-ink-3">{organisationName}</p>
      <h1 className="text-lg font-semibold text-c-ink">{t(titleKey)}</h1>
      <p className="max-w-[420px] text-sm text-c-ink-3">{t(bodyKey)}</p>
      {children}
    </section>
  )
}

export function PreparingState({ organisationName }: { organisationName: string }) {
  return (
    <Block
      organisationName={organisationName}
      titleKey="console.workspace.setup.title-preparing"
      bodyKey="console.workspace.setup.body-preparing"
    />
  )
}

export function ConfirmingOwnerState({ organisationName }: { organisationName: string }) {
  return (
    <Block
      organisationName={organisationName}
      titleKey="console.workspace.setup.title-confirming-owner"
      bodyKey="console.workspace.setup.body-confirming-owner"
    />
  )
}

/** Setup is done and nobody here may create the workspace: no work is running, no action. */
export function NotCreatedState({ organisationName }: { organisationName: string }) {
  return (
    <Block
      organisationName={organisationName}
      titleKey="console.workspace.setup.title-not-created"
      bodyKey="console.workspace.setup.body-not-created"
    />
  )
}

/**
 * The contract gives a stopped setup no reference of its own, so the page quotes the request id
 * of the read that first reported it, labelled as a request id — kept as it was while later reads
 * come and go, and never passed to Aide as a job reference it is not.
 */
export function FailedState({
  org,
  organisationName,
  requestId,
}: {
  org: string
  organisationName: string
  requestId: string | undefined
}) {
  const { t } = useTranslation()
  const [reported] = useState(requestId)
  return (
    <Block
      organisationName={organisationName}
      titleKey="console.workspace.setup.title-failed"
      bodyKey="console.workspace.setup.body-failed"
    >
      {reported === undefined ? null : (
        <p className="font-mono text-xs text-c-ink-3">
          {t('console.workspace.setup.label-request-id', { requestId: reported })}
        </p>
      )}
      <HelpLink org={org} search={{ reason: 'step-failed' }}>
        {t('console.common.action-contact-support')}
      </HelpLink>
    </Block>
  )
}

/** What failed, or what is under way: the creation, or the read after it. */
type Failure = 'create' | 'reread'

/**
 * The owner's or administrator's one action. The key is made when this state is first drawn and
 * kept across a retry whose outcome is unknown; any `4xx` replaces it (`keyAfterFailure`), and a
 * `409` reads the workspace again first. After a creation the workspace is read again, and that
 * read — never the creation's own answer — decides what is drawn next; if that read fails, the
 * page says the service is unavailable and offers to read again, never to create again.
 */
export function ReadyToCreateState({
  organisationId,
  organisationName,
}: {
  organisationId: string
  organisationName: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [key, setKey] = useState(freshKey)
  const [busy, setBusy] = useState<Failure | undefined>(undefined)
  const [failure, setFailure] = useState<Failure | undefined>(undefined)
  // A ref, not the state above: two presses in one frame both see the state as it was before
  // either rendered, and only a ref they share can turn the second away.
  const inFlight = useRef(false)

  const reread = () =>
    queryClient.refetchQueries(
      { queryKey: workspaceQueryKey(organisationId) },
      { throwOnError: true }
    )

  async function run(kind: Failure, step: () => Promise<Failure | undefined>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(kind)
    setFailure(undefined)
    try {
      setFailure(await step())
    } finally {
      inFlight.current = false
      setBusy(undefined)
    }
  }

  const create = () =>
    run('create', async () => {
      try {
        await initialiseWorkspace(organisationId, key)
      } catch (error) {
        setKey((current) => keyAfterFailure(error, current, freshKey))
        if (!isStaleRead(error)) return 'create'
      }
      try {
        await reread()
        return undefined
      } catch {
        return 'reread'
      }
    })

  const readAgain = () =>
    run('reread', async () => {
      try {
        await reread()
        return undefined
      } catch {
        return 'reread'
      }
    })

  return (
    <Block
      organisationName={organisationName}
      titleKey="console.workspace.setup.title-ready"
      bodyKey="console.workspace.setup.body-ready"
    >
      {failure === undefined ? null : (
        <InlineAlert kind="error" className="max-w-[420px] text-left">
          {t('console.common.error-unavailable')}
        </InlineAlert>
      )}
      {failure === 'reread' ? (
        <Button variant="secondary" loading={busy !== undefined} onClick={() => void readAgain()}>
          {t('console.common.action-retry')}
        </Button>
      ) : (
        <Button loading={busy !== undefined} onClick={() => void create()}>
          {t('console.workspace.setup.action-create')}
        </Button>
      )}
      <p aria-live="polite" className="sr-only">
        {busy === 'create' ? t('console.workspace.setup.status-creating') : ''}
      </p>
    </Block>
  )
}
