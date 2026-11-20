import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { coreApi } from '../../api/client'
import { Dialog } from '../../ui/Dialog/Dialog'
import type { FocusTarget } from '../../ui/returnFocus'
import { IconButton } from '../../ui/IconButton'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { formatBytes } from '../../ui/formatBytes'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import type { AttachmentRef } from '../messaging/attachments/attachmentRefs'
import { loadImagePreview } from '../messaging/attachments/imagePreview'
import { safeDownloadUrl } from '../messaging/attachments/MessageAttachments'
import { getFromStorage } from '../messaging/attachments/storageTransport'
import { filesMessages } from './filesMessages'
import type { WorkspaceFileEntry } from './workspaceFiles'

/** The largest text file previewed inline; anything bigger keeps the download path alone. */
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024

const TEXT_PREVIEW_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
])

/**
 * Reads a small text attachment as UTF-8, bounded before and during the transfer: the declared
 * size is checked before any byte is fetched, the stream is cut past the bound, and bytes that are
 * not valid UTF-8 refuse the preview. The result is only ever rendered as React text.
 */
async function loadTextPreview(
  href: string,
  ref: AttachmentRef,
  signal: AbortSignal
): Promise<string | null> {
  if (!TEXT_PREVIEW_TYPES.has(ref.contentType)) return null
  if (!(ref.sizeBytes >= 0 && ref.sizeBytes <= MAX_TEXT_PREVIEW_BYTES)) return null
  const url = new URL(href)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  const response = await getFromStorage(href, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal,
  })
  if (!response.ok || response.body === null) return null
  const limit = Math.min(MAX_TEXT_PREVIEW_BYTES, ref.sizeBytes)
  const reader = response.body.getReader()
  const bytes = new Uint8Array(limit)
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > limit) return null
      bytes.set(value, size)
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
  } catch {
    return null
  }
}

export function FileLightboxModal({
  entries,
  selectedId,
  onSelect,
  onClose,
  onOpenChannel,
  returnFocusTo,
}: {
  returnFocusTo?: FocusTarget
  entries: readonly WorkspaceFileEntry[]
  selectedId: string
  onSelect: (id: string) => void
  onClose: () => void
  onOpenChannel: (entry: WorkspaceFileEntry) => void
}) {
  const organisationId = useMessagingOrganisation()
  const { i18n } = useTranslation()
  const copy = filesMessages[i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr']
  const index = entries.findIndex((entry) => entry.id === selectedId)
  const entry = entries[index]
  const [resource, setResource] = useState<{
    id: string
    org: string
    href: string
    preview: string | null
    text: string | null
    signal: AbortSignal
  } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const move = (step: number) => {
    const next = entries[(index + step + entries.length) % entries.length]
    if (next) onSelect(next.id)
  }
  useEffect(() => {
    if (!entry?.ref || organisationId === null) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    const ref = entry.ref
    void (async () => {
      try {
        const { data } = await coreApi().GET(
          '/organisations/{organisation_id}/workspace/attachments/{attachment_id}',
          {
            params: { path: { organisation_id: organisationId, attachment_id: ref.id } },
            signal: controller.signal,
          }
        )
        const href = safeDownloadUrl(data?.downloadUrl)
        if (!href) throw new Error('attachment-unavailable')
        let text: string | null = null
        if (/^image\/(png|jpeg|gif|webp)$/.test(ref.contentType)) {
          try {
            const blob = await loadImagePreview(href, ref, controller.signal)
            if (controller.signal.aborted) return
            objectUrl = URL.createObjectURL(blob)
          } catch {
            if (controller.signal.aborted) return
          }
        } else if (TEXT_PREVIEW_TYPES.has(ref.contentType)) {
          try {
            text = await loadTextPreview(href, ref, controller.signal)
          } catch {
            if (controller.signal.aborted) return
          }
        }
        if (!controller.signal.aborted)
          setResource({
            id: entry.id,
            org: organisationId,
            href,
            preview: objectUrl,
            text,
            signal: controller.signal,
          })
      } catch {
        if (!controller.signal.aborted) setFailed(entry.id)
      }
    })()
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [entry, organisationId])
  const current =
    resource?.id === entry?.id && resource?.org === organisationId && !resource.signal.aborted
      ? resource
      : null
  return (
    <Dialog
      {...(returnFocusTo ? { returnFocusTo } : {})}
      open={!!entry}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          move(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
      title={entry?.name ?? copy.preview}
      closeLabel={copy.close}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <div className="flex min-h-12 items-center justify-center rounded-md bg-c-sunken p-4">
          {current?.preview ? (
            <img
              src={current.preview}
              alt={entry?.name ?? ''}
              className="max-h-[calc(60vh)] max-w-full object-contain"
            />
          ) : typeof current?.text === 'string' ? (
            <pre
              role="region"
              aria-label={entry?.name ?? copy.preview}
              tabIndex={0}
              className="max-h-[calc(60vh)] w-full overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-c-ink focus-visible:ring focus-visible:outline-hidden"
            >
              {current.text}
            </pre>
          ) : (
            <p role="status" className="text-sm text-c-ink-3">
              {organisationId !== null && entry?.ref && !current && failed !== entry.id
                ? copy.loading
                : copy.noPreview}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <IconButton
            icon="left"
            label={copy.previous}
            disabled={entries.length < 2}
            onClick={() => {
              setFailed(null)
              move(-1)
            }}
          />
          <span className="flex-1 text-xs text-c-ink-3">
            {index + 1} / {entries.length}
            {entry?.sizeBytes === undefined
              ? ''
              : ` · ${formatBytes(entry.sizeBytes, i18n.resolvedLanguage)}`}
          </span>
          <IconButton
            icon="right"
            label={copy.next}
            disabled={entries.length < 2}
            onClick={() => {
              setFailed(null)
              move(1)
            }}
          />
          {current ? (
            <Tooltip content={copy.download} names>
              <a
                href={current.href}
                download={entry?.name}
                target="_blank"
                rel="noreferrer"
                aria-label={copy.download}
                className="tactile flex h-10 w-10 items-center justify-center rounded-md text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
              >
                <KoderaIcon name="download" />
              </a>
            </Tooltip>
          ) : null}
          {entry ? (
            <IconButton
              icon="messages"
              label={`${copy.openChannel} ${entry.directRoomId ? '' : '#'}${entry.channel.label}`}
              onClick={() => onOpenChannel(entry)}
            />
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
