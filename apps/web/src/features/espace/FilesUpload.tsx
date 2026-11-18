import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { track } from '../../analytics/track'
import { Button } from '../../ui/Button/Button'
import { cleanText } from '../../ui/safeText'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import { permitsPlaintext } from '../confidential/room-boundary'
import { AttachmentQueue } from '../messaging/attachments/attachmentQueue'
import { useWorkspaceQuotasQuery } from '../workspace/quotasApi'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import type { EspaceSnapshot } from './matrix/store'
import type { EspaceStoreLike } from './liveViewModel'
import { filesMessages } from './filesMessages'

interface Props {
  store: EspaceStoreLike
  snapshot: EspaceSnapshot
  channels: readonly ChannelSearchEntry[]
}

export function FilesUpload(props: Props) {
  const organisationId = useMessagingOrganisation()
  return organisationId === null ? null : (
    <LiveFilesUpload key={organisationId} {...props} organisationId={organisationId} />
  )
}

function LiveFilesUpload({
  store,
  snapshot,
  channels,
  organisationId,
}: Props & { organisationId: string }) {
  const { i18n } = useTranslation()
  const copy = filesMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const id = useId()
  const quota = useWorkspaceQuotasQuery(organisationId)
  const queue = useMemo(
    () =>
      new AttachmentQueue(organisationId, undefined, (room) => {
        const boundary = store.getRoomBoundary?.(room)
        return (
          (boundary === undefined || permitsPlaintext(boundary)) &&
          store.canSendMessage?.(room) !== false
        )
      }),
    [organisationId, store]
  )
  const [target, setTarget] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queue.close()
    }
  }, [queue])
  const available = channels.flatMap((channel) => {
    const room = snapshot.channels.get(channel.id)
    return channel.kind === 'text' &&
      room?.state === 'resolved' &&
      snapshot.rooms.some((entry) => entry.roomId === room.roomId) &&
      store.canSendMessage?.(room.roomId) !== false
      ? [{ ...channel, roomId: room.roomId }]
      : []
  })
  const roomId = available.find((channel) => channel.id === target)?.roomId ?? ''
  const queued = useSyncExternalStore(queue.subscribe, () => queue.files(roomId))
  const ready = queue.readyRefs(roomId)
  const usage = quota.data
  const remaining =
    usage?.limits.mediaBytes == null ? Infinity : usage.limits.mediaBytes - usage.usage.mediaBytes
  const chosenBytes = queued.reduce((total, file) => total + file.sizeBytes, 0)

  function add(files: readonly File[]) {
    if (files.length === 0 || roomId === '' || sending) return
    if (files.reduce((sum, file) => sum + file.size, chosenBytes) > remaining) {
      setProblem(copy.limit)
      return
    }
    setProblem(null)
    void queue.add(roomId, files)
  }

  async function send() {
    if (
      sending ||
      roomId === '' ||
      ready === null ||
      ready.length === 0 ||
      chosenBytes > remaining ||
      store.canSendMessage?.(roomId) === false
    )
      return
    setSending(true)
    setProblem(null)
    try {
      await store.send(roomId, '', { attachments: ready })
      track('workspace_files_uploaded', { file_count: ready.length })
      queue.clear(roomId)
      void quota.refetch()
    } catch {
      if (mounted.current) setProblem(copy.problem)
    } finally {
      if (mounted.current) setSending(false)
    }
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-c-border p-3"
      aria-label={copy.send}
    >
      <label htmlFor={`${id}-channel`} className="text-sm font-medium text-c-ink">
        {copy.target}
      </label>
      <select
        id={`${id}-channel`}
        value={target}
        disabled={sending || queued.length > 0}
        onChange={(event) => setTarget(event.target.value)}
        className="min-h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
      >
        <option value="">{copy.choose}</option>
        {available.map((channel) => (
          <option key={channel.id} value={channel.id}>
            #{channel.label}
          </option>
        ))}
      </select>
      <label
        htmlFor={`${id}-files`}
        className="flex flex-col gap-2 rounded-md border border-dashed border-c-border-input p-4 text-sm text-c-ink-2"
        onDragOver={(event) => {
          if (roomId !== '') event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          add([...event.dataTransfer.files])
        }}
      >
        {copy.upload}
        <input
          id={`${id}-files`}
          type="file"
          multiple
          disabled={roomId === '' || sending}
          onChange={(event) => {
            add([...(event.target.files ?? [])])
            event.target.value = ''
          }}
        />
      </label>
      {usage === undefined ? (
        <p className="text-xs text-c-ink-3">{copy.unavailable}</p>
      ) : (
        <p className="text-xs text-c-ink-3">
          {copy.quota}:{' '}
          {new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }).format(
            usage.usage.mediaBytes / 1024 ** 3
          )}{' '}
          GB
          {usage.limits.mediaBytes === null
            ? ''
            : ` / ${new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }).format(usage.limits.mediaBytes / 1024 ** 3)} GB`}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {queued.map((file) => (
          <li key={file.key} className="flex items-center justify-between gap-3 text-sm text-c-ink">
            <span>
              {file.filename} —{' '}
              {file.status === 'ready'
                ? copy.ready
                : file.status === 'uploading'
                  ? copy.pending
                  : copy.failed}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={sending}
              aria-label={`${copy.remove} ${cleanText(file.filename, 120)}`}
              onClick={() => queue.remove(roomId, file.key)}
            >
              {copy.remove}
            </Button>
          </li>
        ))}
      </ul>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-c-bad-ink">
          {problem}
        </p>
      )}
      <Button
        disabled={
          roomId === '' ||
          ready === null ||
          ready.length === 0 ||
          sending ||
          chosenBytes > remaining
        }
        onClick={() => void send()}
      >
        {copy.send}
      </Button>
    </section>
  )
}
