import { useRef, useState, type FormEvent, type Ref, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { publicConsoleOrigin } from '../../config'
import { Button } from '../../ui/Button/Button'
import { CopyableField } from '../../ui/CopyableField/CopyableField'
import { Dialog } from '../../ui/Dialog/Dialog'
import type { FocusTarget } from '../../ui/returnFocus'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { QrPanel } from '../../ui/QrPanel/QrPanel'
import { TextField } from '../../ui/TextField/TextField'
import type { WorkspaceChannel } from '../workspace/workspace'
import type { EspaceStoreLike } from './EspaceLiveView'
import { serverNameOf } from './homeserver'
import type { RoomSummary } from './matrix/store'
import { isMatrixUserId, roomInvitationLinks } from './roomInvitations'

export function ChannelInviteDialog({
  org,
  channel,
  room,
  store,
  unavailable,
  triggerRef,
  hideTrigger = false,
  returnFocusTo,
}: {
  org: string
  channel: WorkspaceChannel
  room: RoomSummary
  store: EspaceStoreLike
  unavailable: boolean
  triggerRef?: Ref<HTMLButtonElement>
  hideTrigger?: boolean | undefined
  returnFocusTo?: FocusTarget | undefined
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const [audience, setAudience] = useState(store)
  if (audience !== store) {
    setAudience(store)
    setOpen(false)
  }
  // Remount the form on every opening, discarding late responses.
  return (
    <>
      {hideTrigger ? (
        <button
          ref={triggerRef}
          type="button"
          hidden
          tabIndex={-1}
          aria-hidden="true"
          disabled={unavailable}
          onClick={() => {
            if (!unavailable) setOpen(true)
          }}
        />
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('console.workspace.channel-invite.title')}
        description={t('console.workspace.channel-invite.description', { channel: channel.name })}
        closeLabel={t('console.common.action-close')}
        initialFocus={input}
        {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
        {...(hideTrigger
          ? {}
          : {
              trigger: (
                <Button
                  ref={triggerRef}
                  variant="secondary"
                  size="sm"
                  disabled={unavailable}
                  data-testid="espace-channel-invite-btn"
                >
                  {t('console.workspace.channel-invite.action-open')}
                </Button>
              ),
            })}
      >
        {open ? (
          <InviteForm
            key={room.roomId}
            org={org}
            channel={channel}
            room={room}
            store={store}
            unavailable={unavailable}
            input={input}
          />
        ) : null}
      </Dialog>
    </>
  )
}

function InviteForm({
  org,
  channel,
  room,
  store,
  unavailable,
  input,
}: {
  org: string
  channel: WorkspaceChannel
  room: RoomSummary
  store: EspaceStoreLike
  unavailable: boolean
  input: RefObject<HTMLInputElement | null>
}) {
  const { t } = useTranslation()
  const sending = useRef(false)
  const [matrixId, setMatrixId] = useState('')
  const [pending, setPending] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const serverName =
    serverNameOf(store.getUserId()) ?? room.alias?.split(':').slice(1).join(':') ?? ''
  const links = roomInvitationLinks({
    roomId: room.roomId,
    alias: room.alias,
    serverName,
    channelSlug: channel.name.toLowerCase().replace(/\s+/g, '-'),
    org,
    channelId: channel.id,
    origin: publicConsoleOrigin(org),
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (sending.current || unavailable) return
    setSuccess(null)
    setError(false)
    const userId = matrixId.trim()
    if (!isMatrixUserId(userId)) {
      setInvalid(true)
      input.current?.focus()
      return
    }
    setInvalid(false)
    if (store.inviteToRoom === undefined) return
    sending.current = true
    setPending(true)
    try {
      await store.inviteToRoom(room.roomId, userId)
      setSuccess(userId)
    } catch {
      setError(true)
    } finally {
      sending.current = false
      setPending(false)
    }
  }

  async function copy(key: string, value: string) {
    setCopied(null)
    setCopyError(false)
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
    } catch {
      setCopyError(true)
    }
  }

  // The advanced addresses, for a Matrix client of the invitee's own: collapsed by default, since
  // the web link opens the channel for everyone, in Kodera or in a browser.
  const fields = [
    {
      key: 'matrixTo',
      label: t('console.workspace.channel-invite.matrix-to'),
      value: links.matrixTo,
    },
    {
      key: 'alias',
      label: t(
        room.alias === null
          ? 'console.workspace.channel-invite.alias-suggestion'
          : 'console.workspace.channel-invite.alias'
      ),
      value: links.alias,
    },
    {
      key: 'matrixUri',
      label: t('console.workspace.channel-invite.matrix-uri'),
      value: links.matrixUri,
    },
  ]
  const copyProps = {
    copyLabel: t('console.common.action-copy'),
    copiedLabel: t('console.workspace.channel-invite.copied'),
  }
  const webLabel = t('console.workspace.channel-invite.web')
  return (
    <div className="flex max-h-[calc(60vh)] flex-col gap-4 overflow-y-auto">
      {/* The one link most people need, first: a single click copies it, and the code opens it
      on a phone. */}
      <QrPanel
        value={links.web}
        size="sm"
        className="shrink-0"
        alt={t('console.workspace.channel-invite.qr-alt', { channel: channel.name })}
        failureMessage={t('console.workspace.channel-invite.qr-unavailable')}
        code={{
          ...copyProps,
          label: webLabel,
          value: links.web,
          layout: 'stacked',
          status: copied === 'web' ? 'copied' : 'idle',
          copyAccessibleLabel: t('console.workspace.channel-invite.copy', { label: webLabel }),
          onCopy: () => {
            void copy('web', links.web)
          },
        }}
      />
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event)
        }}
        className="flex flex-col gap-3"
      >
        <TextField
          ref={input}
          label={t('console.workspace.channel-invite.matrix-id')}
          help={t('console.workspace.channel-invite.id-help')}
          value={matrixId}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={pending || unavailable}
          {...(invalid ? { error: t('console.workspace.channel-invite.invalid') } : {})}
          onChange={(event) => {
            setMatrixId(event.target.value)
            setInvalid(false)
            setError(false)
            setSuccess(null)
          }}
        />
        <Button
          type="submit"
          size="sm"
          loading={pending}
          disabled={store.inviteToRoom === undefined || unavailable}
          data-testid="espace-channel-invite-submit"
        >
          {t('console.workspace.channel-invite.action-send')}
        </Button>
        {store.inviteToRoom === undefined ? (
          <InlineAlert kind="info">{t('console.workspace.channel-invite.unavailable')}</InlineAlert>
        ) : null}
        {error ? (
          <InlineAlert kind="error">{t('console.workspace.channel-invite.error')}</InlineAlert>
        ) : null}
        <div role="status" aria-live="polite">
          {success === null ? null : (
            <InlineAlert kind="success" inLiveRegion>
              {t('console.workspace.channel-invite.success', { userId: success })}
            </InlineAlert>
          )}
        </div>
      </form>
      <details className="group shrink-0 rounded-md border border-c-border-soft">
        <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-semibold text-c-ink-2 hover:text-c-ink focus-visible:ring focus-visible:outline-hidden">
          {t('console.workspace.channel-invite.advanced')}
        </summary>
        <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
          <p className="text-sm text-c-ink-2">{t('console.workspace.channel-invite.clients')}</p>
          {fields.map((field) => (
            <CopyableField
              key={field.key}
              {...copyProps}
              label={field.label}
              value={field.value}
              layout="stacked"
              status={copied === field.key ? 'copied' : 'idle'}
              className="shrink-0"
              copyAccessibleLabel={t('console.workspace.channel-invite.copy', {
                label: field.label,
              })}
              onCopy={() => {
                void copy(field.key, field.value)
              }}
            />
          ))}
        </div>
      </details>
      {copyError ? (
        <InlineAlert kind="error">{t('console.workspace.channel-invite.copy-error')}</InlineAlert>
      ) : null}
    </div>
  )
}
