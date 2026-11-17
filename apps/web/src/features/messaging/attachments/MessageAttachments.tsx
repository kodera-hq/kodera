// Files stay metadata-only until opened. Raster images use bounded, credential-free reads and
// local blob previews; every other format opens outside the console in a fresh tab.

import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../../ui/Dialog/Dialog'
import { cleanText } from '../../../ui/safeText'
import { filesMessages } from '../../espace/filesMessages'
import { loadImagePreview } from './imagePreview'
import { useTranslation } from 'react-i18next'
import { coreApi } from '../../../api/client'
import { useMessagingOrganisation } from '../organisationContext'
import type { AttachmentRef } from './attachmentRefs'

const CHIP =
  'flex min-h-10 max-w-full items-center gap-2 rounded-md border border-c-border bg-c-sunken px-3 py-2 text-left text-sm text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:cursor-not-allowed disabled:text-c-on-disabled'

/** A download address Core issued: https only, no credentials in it. */
export function safeDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    return url.href
  } catch {
    return null
  }
}

function sizeOf(bytes: number, language: string | undefined): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}

export function MessageAttachments({ refs }: { refs: readonly AttachmentRef[] }) {
  const { t, i18n } = useTranslation()
  const organisationId = useMessagingOrganisation()
  const [problem, setProblem] = useState(false)
  const [preview, setPreview] = useState<{
    url: string
    name: string
    organisationId: string
  } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const objectUrl = useRef<string | null>(null)
  const live = useRef(false)
  const copy = filesMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const closePreview = () => {
    request.current?.abort()
    if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    setPreview(null)
  }
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      request.current?.abort()
      if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current)
    }
  }, [organisationId])
  async function open(ref: AttachmentRef) {
    if (organisationId === null) return
    setProblem(false)
    if (/^image\/(png|jpeg|gif|webp)$/.test(ref.contentType)) {
      closePreview()
      const abort = new AbortController()
      request.current = abort
      setPending(organisationId)
      try {
        const { data } = await coreApi().GET(
          '/organisations/{organisation_id}/workspace/attachments/{attachment_id}',
          {
            params: { path: { organisation_id: organisationId, attachment_id: ref.id } },
            signal: abort.signal,
          }
        )
        const href = safeDownloadUrl(data?.downloadUrl)
        if (href === null) throw new Error('attachment-unavailable')
        const blob = await loadImagePreview(href, ref, abort.signal)
        if (abort.signal.aborted || !live.current) return
        const url = URL.createObjectURL(blob)
        objectUrl.current = url
        setPreview({ url, name: cleanText(ref.filename, 120), organisationId })
      } catch {
        if (!abort.signal.aborted && live.current) setProblem(true)
      } finally {
        if (request.current === abort && live.current) setPending(null)
      }
      return
    }
    // The tab is opened now, within the click, so no pop-up blocker stands in the way; it is
    // pointed at the file once Core answers, and closed if it does not.
    const tab = window.open('about:blank', '_blank')
    if (tab !== null) tab.opener = null
    try {
      const { data } = await coreApi().GET(
        '/organisations/{organisation_id}/workspace/attachments/{attachment_id}',
        { params: { path: { organisation_id: organisationId, attachment_id: ref.id } } }
      )
      const href = safeDownloadUrl(data?.downloadUrl)
      if (href === null) throw new Error('attachment-unavailable')
      if (tab === null) window.location.assign(href)
      else tab.location.replace(href)
    } catch {
      tab?.close()
      if (live.current) setProblem(true)
    }
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <ul
        aria-label={t('console.workspace.attachments.label-list')}
        className="flex flex-wrap gap-2"
      >
        {refs.map((ref) => (
          <li key={ref.id} className="max-w-full">
            <button
              type="button"
              className={CHIP}
              disabled={organisationId === null || pending === organisationId}
              onClick={() => void open(ref)}
              aria-label={
                ref.contentType.startsWith('image/')
                  ? `${copy.preview}: ${cleanText(ref.filename, 120)}`
                  : t('console.workspace.attachments.action-open', {
                      name: cleanText(ref.filename, 120),
                    })
              }
            >
              <span aria-hidden="true">📎</span>
              <span className="min-w-0 truncate">{cleanText(ref.filename, 120)}</span>
              <span className="shrink-0 text-xs text-c-ink-3">
                {sizeOf(ref.sizeBytes, i18n.resolvedLanguage)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={preview !== null && preview.organisationId === organisationId}
        onOpenChange={(open) => {
          if (!open) closePreview()
        }}
        title={preview?.name ?? copy.preview}
        closeLabel={copy.close}
        size="lg"
      >
        {preview === null ? null : (
          <img
            src={preview.url}
            alt={preview.name}
            className="max-h-screen w-full object-contain"
          />
        )}
      </Dialog>
      {problem ? (
        <p role="status" className="text-xs text-c-bad-ink">
          {t('console.workspace.attachments.problem-open')}
        </p>
      ) : null}
    </div>
  )
}
