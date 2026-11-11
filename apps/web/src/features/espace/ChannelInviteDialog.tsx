import { useRef, useState, type FormEvent, type Ref, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { CopyableField } from '../../ui/CopyableField/CopyableField'
import { Dialog } from '../../ui/Dialog/Dialog'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
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
}: {
  org: string
  channel: WorkspaceChannel
  room: RoomSummary
  store: EspaceStoreLike
  unavailable: boolean
  triggerRef?: Ref<HTMLButtonElement>
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
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={t('console.workspace.channel-invite.title')}
      description={t('console.workspace.channel-invite.description', { channel: channel.name })}
      closeLabel={t('console.common.action-close')}
      initialFocus={input}
      trigger={
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          disabled={unavailable}
          data-testid="espace-channel-invite-btn"
        >
          {t('console.workspace.channel-invite.action-open')}
        </Button>
      }
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
    origin: window.location.origin,
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
    { key: 'web', label: t('console.workspace.channel-invite.web'), value: links.web },
  ]
  return (
    <div className="flex max-h-[calc(60vh)] flex-col gap-4 overflow-y-auto">
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
      <p className="text-sm text-c-ink-2">{t('console.workspace.channel-invite.clients')}</p>
      {fields.map((field) => (
        <CopyableField
          key={field.key}
          label={field.label}
          value={field.value}
          layout="stacked"
          status={copied === field.key ? 'copied' : 'idle'}
          className="shrink-0"
          copyLabel={t('console.common.action-copy')}
          copyAccessibleLabel={t('console.workspace.channel-invite.copy', { label: field.label })}
          copiedLabel={t('console.workspace.channel-invite.copied')}
          onCopy={() => {
            void copy(field.key, field.value)
          }}
        />
      ))}
      {copyError ? (
        <InlineAlert kind="error">{t('console.workspace.channel-invite.copy-error')}</InlineAlert>
      ) : null}
    </div>
  )
}
