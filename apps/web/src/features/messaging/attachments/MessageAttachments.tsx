import { formatBytes } from '../../../ui/formatBytes'
// Files stay metadata-only until opened, except safe raster images (<= 10 MiB) in non-quarantined
// rooms which resolve via bounded credential-free reads into CSP-safe local `blob:` URLs
// (`img-src 'self' blob:`) and open the Lightbox when clicked.

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { coreApi } from '../../../api/client'
import { Dialog } from '../../../ui/Dialog/Dialog'
import { cleanText } from '../../../ui/safeText'
import { filesMessages } from '../../espace/filesMessages'
import { useMessagingOrganisation } from '../organisationContext'
import { isVoiceNoteType, type AttachmentRef } from './attachmentRefs'
import { loadImagePreview } from './imagePreview'

const LazyVoiceNotePlayer = lazy(() =>
  import('./VoiceNotePlayer').then((module) => ({ default: module.VoiceNotePlayer }))
)

const CHIP =
  'flex min-h-10 max-w-full items-center gap-2 rounded-md border border-c-border bg-c-sunken px-3 py-2 text-left text-sm text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:cursor-not-allowed disabled:text-c-on-disabled'

const SAFE_RASTER_MIME = /^image\/(png|jpeg|gif|webp)$/
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_INLINE_CACHE_ENTRIES = 48

// Bounded LRU cache of CSP-safe `blob:` URLs (`${organisationId}:${attachmentId}` -> `blob:...`).
const inlineBlobCache = new Map<string, string>()

function safeCreateBlobUrl(blob: Blob): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  try {
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

function safeRevokeBlobUrl(url: string | null | undefined): void {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // Ignore already-revoked object URLs.
  }
}

function cacheInlineBlobUrl(key: string, url: string): void {
  if (inlineBlobCache.has(key)) {
    const prev = inlineBlobCache.get(key)
    inlineBlobCache.delete(key)
    if (prev && prev !== url) safeRevokeBlobUrl(prev)
  }
  while (inlineBlobCache.size >= MAX_INLINE_CACHE_ENTRIES) {
    const oldestKey = inlineBlobCache.keys().next().value
    if (oldestKey === undefined) break
    const oldestUrl = inlineBlobCache.get(oldestKey)
    inlineBlobCache.delete(oldestKey)
    safeRevokeBlobUrl(oldestUrl)
  }
  inlineBlobCache.set(key, url)
}

export function clearInlineAttachmentPreviews(organisationId?: string): void {
  if (organisationId === undefined) {
    for (const url of inlineBlobCache.values()) safeRevokeBlobUrl(url)
    inlineBlobCache.clear()
    return
  }
  const prefix = `${organisationId}:`
  for (const [key, url] of inlineBlobCache.entries()) {
    if (key.startsWith(prefix)) {
      safeRevokeBlobUrl(url)
      inlineBlobCache.delete(key)
    }
  }
}

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

function InlineRasterAttachment({
  attachment,
  organisationId,
  plaintextPermitted,
  pending,
  previewLabel,
  locale,
  onOpenLightbox,
  onOpenFallback,
}: {
  attachment: AttachmentRef
  organisationId: string | null
  plaintextPermitted: boolean
  pending: boolean
  previewLabel: string
  locale: string | undefined
  onOpenLightbox: (url: string, name: string) => void
  onOpenFallback: (ref: AttachmentRef) => void
}) {
  const cleanName = cleanText(attachment.filename, 120)
  const cacheKey = organisationId ? `${organisationId}:${attachment.id}` : ''
  const eligible =
    organisationId !== null &&
    plaintextPermitted &&
    SAFE_RASTER_MIME.test(attachment.contentType) &&
    attachment.sizeBytes > 0 &&
    attachment.sizeBytes <= MAX_INLINE_IMAGE_BYTES

  const [fetchedEntry, setFetchedEntry] = useState<{
    readonly key: string
    readonly url: string
  } | null>(null)

  const cachedUrl = eligible && cacheKey ? (inlineBlobCache.get(cacheKey) ?? null) : null
  const inlineUrl =
    eligible && cacheKey
      ? (cachedUrl ?? (fetchedEntry?.key === cacheKey ? fetchedEntry.url : null))
      : null

  useEffect(() => {
    if (!eligible || organisationId === null || !cacheKey) {
      return
    }
    if (inlineBlobCache.has(cacheKey)) {
      return
    }

    const abort = new AbortController()
    let active = true
    void (async () => {
      try {
        const { data } = await coreApi().GET(
          '/organisations/{organisation_id}/workspace/attachments/{attachment_id}',
          {
            params: { path: { organisation_id: organisationId, attachment_id: attachment.id } },
            signal: abort.signal,
          }
        )
        const href = safeDownloadUrl(data?.downloadUrl)
        if (href === null) return
        const blob = await loadImagePreview(href, attachment, abort.signal)
        if (!active || abort.signal.aborted) return
        const url = safeCreateBlobUrl(blob)
        if (url === null) return
        cacheInlineBlobUrl(cacheKey, url)
        setFetchedEntry({ key: cacheKey, url })
      } catch {
        // Graceful fallback to the accessible file chip if fetch fails.
      }
    })()

    return () => {
      active = false
      abort.abort()
    }
  }, [attachment, cacheKey, eligible, organisationId])

  if (inlineUrl !== null && eligible) {
    return (
      <button
        type="button"
        disabled={organisationId === null || pending}
        onClick={() => onOpenLightbox(inlineUrl, cleanName)}
        aria-label={`${previewLabel}: ${cleanName}`}
        className="group block overflow-hidden rounded-lg focus-visible:ring focus-visible:outline-hidden disabled:cursor-not-allowed"
      >
        <img
          src={inlineUrl}
          alt={cleanName}
          data-testid="timeline-inline-image-preview"
          className="max-h-[256px] max-w-[384px] rounded-lg border border-c-border bg-c-sunken object-contain"
        />
      </button>
    )
  }

  return (
    <button
      type="button"
      className={CHIP}
      disabled={organisationId === null || pending}
      onClick={() => onOpenFallback(attachment)}
      aria-label={`${previewLabel}: ${cleanName}`}
    >
      <span aria-hidden="true">📎</span>
      <span className="min-w-0 truncate">{cleanName}</span>
      <span className="shrink-0 text-xs text-c-ink-3">
        {formatBytes(attachment.sizeBytes, locale)}
      </span>
    </button>
  )
}

export function MessageAttachments({
  refs,
  plaintextPermitted = true,
}: {
  refs: readonly AttachmentRef[]
  plaintextPermitted?: boolean | undefined
}) {
  const { t, i18n } = useTranslation()
  const organisationId = useMessagingOrganisation()
  const [problem, setProblem] = useState(false)
  const [preview, setPreview] = useState<{
    url: string
    name: string
    organisationId: string
    ephemeral: boolean
  } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const objectUrl = useRef<string | null>(null)
  const live = useRef(false)
  const copy = filesMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']

  const closePreview = () => {
    request.current?.abort()
    if (objectUrl.current !== null) safeRevokeBlobUrl(objectUrl.current)
    objectUrl.current = null
    setPreview(null)
  }

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      request.current?.abort()
      if (objectUrl.current !== null) safeRevokeBlobUrl(objectUrl.current)
    }
  }, [organisationId])

  async function open(ref: AttachmentRef) {
    if (organisationId === null) return
    setProblem(false)
    if (SAFE_RASTER_MIME.test(ref.contentType)) {
      closePreview()
      const cached = inlineBlobCache.get(`${organisationId}:${ref.id}`)
      if (cached !== undefined) {
        setPreview({
          url: cached,
          name: cleanText(ref.filename, 120),
          organisationId,
          ephemeral: false,
        })
        return
      }
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
        const url = safeCreateBlobUrl(blob)
        if (url === null) throw new Error('attachment-unavailable')
        objectUrl.current = url
        setPreview({
          url,
          name: cleanText(ref.filename, 120),
          organisationId,
          ephemeral: true,
        })
      } catch {
        if (!abort.signal.aborted && live.current) setProblem(true)
      } finally {
        if (request.current === abort && live.current) setPending(null)
      }
      return
    }
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

  const voiceNotes = refs.filter((ref) => isVoiceNoteType(ref.contentType))
  const fileRefs = refs.filter((ref) => !isVoiceNoteType(ref.contentType))
  return (
    <div className="mt-2 flex flex-col gap-2">
      {voiceNotes.length > 0 ? (
        <Suspense fallback={null}>
          {voiceNotes.map((ref) => (
            <LazyVoiceNotePlayer key={ref.id} attachment={ref} organisationId={organisationId} />
          ))}
        </Suspense>
      ) : null}
      {fileRefs.length > 0 ? (
        <ul
          aria-label={t('console.workspace.attachments.label-list')}
          className="flex flex-wrap gap-2"
        >
          {fileRefs.map((ref) => (
            <li key={ref.id} className="max-w-full">
              {SAFE_RASTER_MIME.test(ref.contentType) ? (
                <InlineRasterAttachment
                  attachment={ref}
                  organisationId={organisationId}
                  plaintextPermitted={plaintextPermitted}
                  pending={pending === organisationId}
                  previewLabel={copy.preview}
                  locale={i18n.resolvedLanguage}
                  onOpenLightbox={(url, name) => {
                    if (organisationId === null) return
                    closePreview()
                    setPreview({ url, name, organisationId, ephemeral: false })
                  }}
                  onOpenFallback={(target) => void open(target)}
                />
              ) : (
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
                    {formatBytes(ref.sizeBytes, i18n.resolvedLanguage)}
                  </span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        open={preview !== null && preview.organisationId === organisationId}
        onOpenChange={(openState) => {
          if (!openState) closePreview()
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
