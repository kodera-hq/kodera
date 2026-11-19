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
import { loadImagePreview } from '../messaging/attachments/imagePreview'
import { safeDownloadUrl } from '../messaging/attachments/MessageAttachments'
import { filesMessages } from './filesMessages'
import type { WorkspaceFileEntry } from './workspaceFiles'

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
        if (/^image\/(png|jpeg|gif|webp)$/.test(ref.contentType)) {
          try {
            const blob = await loadImagePreview(href, ref, controller.signal)
            if (controller.signal.aborted) return
            objectUrl = URL.createObjectURL(blob)
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
