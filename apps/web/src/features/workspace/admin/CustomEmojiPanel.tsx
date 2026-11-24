// Workspace custom emoji administration panel: resizes raster uploads via <canvas> to <= 128x128
// WebP before base64 submission, and renders sanitized blob: previews.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../../api/client'
import { Button } from '../../../ui/Button/Button'
import { TextField } from '../../../ui/TextField/TextField'
import {
  refreshWorkspaceCustomEmojis,
  setWorkspaceCustomEmojisSnapshot,
  useCustomEmojis,
} from '../../espace/customEmojiStore'
import {
  createWorkspaceCustomEmoji,
  deleteWorkspaceCustomEmoji,
} from '../../espace/experienceApi'
import { experienceCopy } from '../../espace/experienceMessages'
import { CustomWorkspaceEmoji } from '../../espace/KoderaEmoji'

const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/
const MAX_DIMENSION = 128
const MAX_WEBP_BYTES = 262_144
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/**
 * Resize a raster image file on the client via `<canvas>` to `<= 128x128` WebP (`image/webp`)
 * and return its base64 payload (<= 256 KiB).
 */
export async function resizeFileToCustomEmojiWebpBase64(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number]) || file.size === 0) {
    throw new Error('invalid_image_type')
  }

  // If the file is already a small WebP and browser canvas decode isn't available (e.g. jsdom),
  // fall back to reading the WebP bytes directly so server-side RIFF sanitizer validates & strips metadata.
  if (file.type === 'image/webp' && typeof createImageBitmap !== 'function') {
    const raw = new Uint8Array(await file.arrayBuffer())
    if (raw.byteLength === 0 || raw.byteLength > MAX_WEBP_BYTES) {
      throw new Error('invalid_image_size')
    }
    return bytesToBase64(raw)
  }

  if (typeof createImageBitmap !== 'function') {
    throw new Error('canvas_unavailable')
  }

  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_DIMENSION / bitmap.width, MAX_DIMENSION / bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('canvas_context_unavailable')
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((out) => resolve(out), 'image/webp', 0.9)
      } else {
        resolve(null)
      }
    })

    if (blob !== null && blob.type === 'image/webp' && blob.size > 0) {
      if (blob.size > MAX_WEBP_BYTES) throw new Error('invalid_image_size')
      return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
    }

    const dataUrl = canvas.toDataURL('image/webp', 0.9)
    const prefix = 'data:image/webp;base64,'
    if (!dataUrl.startsWith(prefix)) {
      if (file.type === 'image/webp' && file.size <= MAX_WEBP_BYTES) {
        return bytesToBase64(new Uint8Array(await file.arrayBuffer()))
      }
      throw new Error('webp_encode_unavailable')
    }
    return dataUrl.slice(prefix.length)
  } finally {
    bitmap.close()
  }
}

export function CustomEmojiPanel({
  organisationId,
  canEdit,
}: {
  organisationId: string
  canEdit: boolean
}) {
  const { i18n } = useTranslation()
  const copy = experienceCopy(i18n.resolvedLanguage).customEmojis
  const { items } = useCustomEmojis(organisationId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileInputId = useId()
  const [shortcode, setShortcode] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refreshWorkspaceCustomEmojis(organisationId, true)
  }, [organisationId])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || busy) return
    const normalized = shortcode.trim().toLowerCase()
    if (!SHORTCODE_RE.test(normalized) || normalized.startsWith('kodera_')) {
      setError(copy.errShortcodeInvalid)
      return
    }
    if (selectedFile === null) {
      setError(copy.errImageInvalid)
      return
    }

    setBusy(true)
    setError(null)
    try {
      const webpBase64 = await resizeFileToCustomEmojiWebpBase64(selectedFile)
      const created = await createWorkspaceCustomEmoji(organisationId, {
        shortcode: normalized,
        webpBase64,
      })
      const next = [...items.filter((item) => item.id !== created.id), created].sort((a, b) =>
        a.shortcode.localeCompare(b.shortcode)
      )
      setWorkspaceCustomEmojisSnapshot(organisationId, next)
      setShortcode('')
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 409) {
        setError(copy.errShortcodeConflict)
      } else if (err instanceof ApiProblem && err.status === 422) {
        setError(copy.errImageInvalid)
      } else if (err instanceof Error && err.message.startsWith('invalid_image')) {
        setError(copy.errImageInvalid)
      } else {
        setError(copy.errGeneric)
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(emojiId: string) {
    if (!canEdit || busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteWorkspaceCustomEmoji(organisationId, emojiId)
      setWorkspaceCustomEmojisSnapshot(
        organisationId,
        items.filter((item) => item.id !== emojiId)
      )
    } catch {
      setError(copy.errGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="custom-emoji-panel"
      className="flex flex-col gap-4 rounded-lg border border-c-border p-5"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-c-ink">{copy.heading}</h3>
        <p className="text-sm text-c-ink-2">{copy.subtitle}</p>
      </div>

      {canEdit ? (
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <TextField
              label={copy.shortcodeLabel}
              value={shortcode}
              maxLength={32}
              placeholder={copy.shortcodePlaceholder}
              onChange={(event) => {
                setShortcode(event.target.value)
                setError(null)
              }}
            />
            <p className="text-xs text-c-ink-3">{copy.shortcodeHint}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              id={fileInputId}
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              className="sr-only"
              onChange={(event) => {
                setSelectedFile(event.target.files?.[0] ?? null)
                setError(null)
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              {copy.chooseFile}
            </Button>
            {selectedFile !== null ? (
              <span className="max-w-[240px] truncate text-xs text-c-ink-2">
                {copy.selectedFile(selectedFile.name)}
              </span>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || shortcode.trim() === '' || selectedFile === null}
            >
              {busy ? copy.uploading : copy.uploadAction}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-c-ink-3">{copy.readOnly}</p>
      )}

      {error !== null ? (
        <p role="alert" className="text-xs text-c-bad-ink">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-c-ink-3">{copy.empty}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 narrow:grid-cols-1">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <CustomWorkspaceEmoji
                  organisationId={organisationId}
                  shortcode={item.shortcode}
                />
                <span className="truncate font-mono text-sm text-c-ink">:{item.shortcode}:</span>
              </div>
              {canEdit ? (
                <Button
                  type="button"
                  variant="tertiary"
                  size="sm"
                  disabled={busy}
                  aria-label={copy.deleteAction(item.shortcode)}
                  onClick={() => void handleDelete(item.id)}
                >
                  ×
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
