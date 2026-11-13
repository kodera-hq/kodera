// The files a message carries, as chips (docs/specs/messaging-media-and-notifications.md). Nothing
// is fetched to draw them: the name, type and size come from the message. Opening one asks Core for
// a fresh, short-lived download address and navigates to it in a new tab, so the file never runs
// inside the console's origin and the console's policy needs no storage source for images.

import { useState } from 'react'
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
  const units = ['B', 'KB', 'MB'] as const
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
  async function open(ref: AttachmentRef) {
    if (organisationId === null) return
    setProblem(false)
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
      setProblem(true)
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
              disabled={organisationId === null}
              onClick={() => void open(ref)}
              aria-label={t('console.workspace.attachments.action-open', { name: ref.filename })}
            >
              <span aria-hidden="true">📎</span>
              <span className="min-w-0 truncate">{ref.filename}</span>
              <span className="shrink-0 text-xs text-c-ink-3">
                {sizeOf(ref.sizeBytes, i18n.resolvedLanguage)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {problem ? (
        <p role="status" className="text-xs text-c-bad-ink">
          {t('console.workspace.attachments.problem-open')}
        </p>
      ) : null}
    </div>
  )
}
