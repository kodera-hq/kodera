import type { components } from '../../api/schema'

export const BUG_COMPONENTS = [
  'workspace',
  'messaging',
  'calls',
  'docs',
  'files',
  'auth',
  'billing',
  'settings',
  'confidential',
  'desktop',
  'mobile',
  'other',
] as const

export type BugComponent = (typeof BUG_COMPONENTS)[number]

export const BUG_DEVICE_CLASSES = [
  'web-desktop',
  'web-mobile',
  'desktop-macos',
  'desktop-linux',
  'desktop-windows',
  'ios',
  'android',
] as const

export type BugDeviceClass = (typeof BUG_DEVICE_CLASSES)[number]
export type BugScreenshotContentType = 'image/png' | 'image/webp'

export type BugNoteRefusalCode =
  | 'bearer_token'
  | 'jwt_token'
  | 'api_credential'
  | 'pem_material'
  | 'invite_or_auth_link'
  | 'url_forbidden'

export const MAX_BUG_NOTE_LENGTH = 500
export const MAX_SCREENSHOT_BYTES = 256 * 1024
export const BLUR_CSS_FILTER = 'blur(12px)'
export const BLUR_DOWNSCALE_DIVISOR = 14

const BUILD_ID_RE = new RegExp(
  [
    '^(?:',
    String.raw`(?:(?:web|desktop|ios|android|server|cli)-)?v?\d{1,4}\.\d{1,4}\.\d{1,4}`,
    String.raw`(?:-[0-9A-Za-z.]{1,24})?(?:\+(?:sha\.)?[0-9a-f]{7,12})?`,
    '|[0-9a-f]{7,12}',
    '|dev|local|unknown',
    ')$',
  ].join('')
)
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_.:-]{0,79}$/

const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [BugNoteRefusalCode, RegExp]> = [
  ['bearer_token', /\bBearer\s+\S+/i],
  ['jwt_token', /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,})?/],
  [
    'api_credential',
    new RegExp(
      [
        String.raw`(?<![A-Za-z0-9])rk_[A-Za-z0-9_-]{4,}`,
        String.raw`(?<![A-Za-z0-9])sk_[A-Za-z0-9_-]{4,}`,
        String.raw`(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{4,}`,
        String.raw`(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{4,}`,
        String.raw`(?<![A-Za-z0-9])ph[cs]_[A-Za-z0-9_]{4,}`,
        String.raw`(?<![A-Za-z0-9])(?:syt|syr|mda)_[A-Za-z0-9_=-]{4,}`,
        String.raw`(?<![A-Za-z0-9])SCW[A-Z0-9]{6,}`,
        String.raw`(?<![A-Za-z0-9])A[KS]IA[A-Z0-9]{8,}`,
        String.raw`(?<![A-Za-z0-9])oc1_[0-9a-fA-F_-]{4,}`,
        String.raw`(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{4,}`,
        String.raw`(?<![A-Za-z0-9_-])(?:access_token|refresh_token|id_token|session_token|auth_token|token|api_key|apikey|x_api_key|x-api-key|secret|client_secret|private_key|password|passwd|authorization|bearer|jwt|cookie|set-cookie)\s*[:=]\s*\S+`,
      ].join('|'),
      'i'
    ),
  ],
  ['pem_material', /-----BEGIN\b/i],
  [
    'invite_or_auth_link',
    new RegExp(
      [
        '/invitations/',
        '/invite/',
        String.raw`/claim(?:/|\?|\b)`,
        String.raw`/magic(?:/|\?|\b)`,
        String.raw`[?&](?:token|code|access_token|id_token)=`,
        String.raw`\x23(?:token|access_token)=`,
      ].join('|'),
      'i'
    ),
  ],
  [
    'url_forbidden',
    new RegExp(
      [
        String.raw`\b(?:https?|wss?|ftps?|file|kodera)://`,
        String.raw`\bmatrix:`,
        String.raw`(?<![A-Za-z0-9+.-]:)//(?:[^\s/?\x23@]+@)?(?:localhost|\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?(?=[/?\x23\s),.:;!\]}>\x27\x22]|$)`,
      ].join('|'),
      'i'
    ),
  ],
]

const MATRIX_USER_OR_ROOM_RE = new RegExp(
  String.raw`(?<![\w.])[!@\x23][A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+(?::\d{1,5})?`,
  'g'
)
const MATRIX_EVENT_RE = /(?<![\w.])\$[A-Za-z0-9._~+/-]{4,}(?::[A-Za-z0-9.-]+(?::\d{1,5})?)?/g
const EMAIL_RE =
  /\b[\w.%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/g
const UUID_RE =
  /(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])/g
const IPV4_RE =
  /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g
const IPV6_CANDIDATE_RE =
  /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}(?![\w:])|(?:[0-9a-fA-F]{0,4}:){1,6}:[0-9a-fA-F]{0,4}/g
const PHONE_RE = /(?<!\d)\+?\d(?:[ .()/-]*\d){6,14}(?!\d)/g
const LONG_DIGIT_RUN_RE = /\d{5,}/

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FORBIDDEN_PNG_CHUNKS = new Set(['text', 'itxt', 'ztxt', 'exif', 'time'])
const FORBIDDEN_WEBP_CHUNKS = new Set(['EXIF', 'XMP'])

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface ScrubberContext {
  organisationSlug?: string | undefined
  tenantSlug?: string | undefined
}

export function hasForbiddenSecretOrUrl(value: string): boolean {
  for (const [, pattern] of FORBIDDEN_PATTERNS) {
    if (pattern.test(value)) return true
  }
  return false
}

const SEMVER_BUILD_CORE_RE =
  /^(?:(?:web|desktop|ios|android|server|cli)-)?v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:\+(?:sha\.)?[0-9a-f]{7,12})?/

export function containsPiiOrIdentifier(
  value: string,
  context?: ScrubberContext,
  allowSemverDigits = false
): boolean {
  if (!value) return false
  for (const re of [
    MATRIX_USER_OR_ROOM_RE,
    MATRIX_EVENT_RE,
    EMAIL_RE,
    UUID_RE,
    IPV4_RE,
    IPV6_CANDIDATE_RE,
  ]) {
    re.lastIndex = 0
    if (re.test(value)) return true
  }
  const phoneProbe = allowSemverDigits ? value.replace(SEMVER_BUILD_CORE_RE, 'v') : value
  PHONE_RE.lastIndex = 0
  if (PHONE_RE.test(phoneProbe)) return true
  for (const slug of [context?.organisationSlug, context?.tenantSlug]) {
    if (slug && slug.length >= 2) {
      const slugTokenRe = new RegExp(
        String.raw`(?<![A-Za-z0-9])${escapeRegExp(slug)}(?![A-Za-z0-9])`,
        'i'
      )
      if (slugTokenRe.test(value)) return true
    }
  }
  return false
}

export function isValidBuildId(value: string, context?: ScrubberContext): boolean {
  return (
    value.length >= 1 &&
    value.length <= 64 &&
    BUILD_ID_RE.test(value) &&
    !hasForbiddenSecretOrUrl(value) &&
    !containsPiiOrIdentifier(value, context, true)
  )
}

export function isValidErrorCode(value: string, context?: ScrubberContext): boolean {
  return (
    value.length >= 1 &&
    value.length <= 80 &&
    ERROR_CODE_RE.test(value) &&
    !LONG_DIGIT_RUN_RE.test(value) &&
    !hasForbiddenSecretOrUrl(value) &&
    !containsPiiOrIdentifier(value, context)
  )
}

export function detectBuildId(envBuildId?: string): string {
  const candidate = (envBuildId ?? import.meta.env['VITE_BUILD_ID'] ?? '').trim()
  if (candidate && isValidBuildId(candidate)) return candidate
  return 'web-0.1.1'
}

export function detectDeviceClass(userAgent?: string, maxTouchPoints?: number): BugDeviceClass {
  const ua = (
    userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  ).toLowerCase()
  const touch = maxTouchPoints ?? (typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0)
  if (ua.includes('tauri') || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)) {
    if (ua.includes('mac')) return 'desktop-macos'
    if (ua.includes('win')) return 'desktop-windows'
    return 'desktop-linux'
  }
  if (ua.includes('android') || ua.includes('iphone') || ua.includes('ipad') || touch > 1) {
    return 'web-mobile'
  }
  return 'web-desktop'
}

export interface NoteInspection {
  normalizedInput: string
  blockedReasons: BugNoteRefusalCode[]
  sanitizedNote: string
  exceedsMaxLength: boolean
}

export function inspectBugReportNote(raw: string, context?: ScrubberContext): NoteInspection {
  const normalizedInput = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = normalizedInput.trim()
  if (trimmed === '') {
    return {
      normalizedInput: '',
      blockedReasons: [],
      sanitizedNote: '',
      exceedsMaxLength: false,
    }
  }

  const blockedReasons: BugNoteRefusalCode[] = []
  for (const [code, pattern] of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) blockedReasons.push(code)
  }

  let sanitized = trimmed
    .replace(MATRIX_USER_OR_ROOM_RE, '[REDACTED_MATRIX_ID]')
    .replace(MATRIX_EVENT_RE, '[REDACTED_MATRIX_ID]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(UUID_RE, '[REDACTED_UUID]')
    .replace(IPV6_CANDIDATE_RE, (match) => (match.includes(':') ? '[REDACTED_IP]' : match))
    .replace(IPV4_RE, '[REDACTED_IP]')
    .replace(PHONE_RE, '[REDACTED_PHONE]')

  if (context?.tenantSlug && context.tenantSlug.length >= 2) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(context.tenantSlug), 'gi'),
      '[REDACTED_TENANT]'
    )
  }
  if (context?.organisationSlug && context.organisationSlug.length >= 2) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(context.organisationSlug), 'gi'),
      '[REDACTED_ORG]'
    )
  }

  return {
    normalizedInput: trimmed,
    blockedReasons,
    sanitizedNote: sanitized,
    exceedsMaxLength: trimmed.length > MAX_BUG_NOTE_LENGTH,
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize)
    chunks.push(String.fromCharCode(...slice))
  }
  return btoa(chunks.join(''))
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function concatChunks(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let pos = 0
  for (const part of parts) {
    merged.set(part, pos)
    pos += part.length
  }
  return merged
}

/**
 * Strip any tEXt / iTXt / zTXt / eXIf / tIME chunks from PNG or EXIF / XMP chunks from WebP
 * and validate exact binary framing before attaching to a bug report.
 */
export function stripAndValidateImageBytes(
  bytes: Uint8Array,
  contentType: BugScreenshotContentType
): Uint8Array {
  if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new Error('Screenshot exceeds 256 KiB limit.')
  }

  if (contentType === 'image/png') {
    if (bytes.length < 33) throw new Error('Invalid PNG header.')
    for (let i = 0; i < PNG_MAGIC.length; i++) {
      if (bytes[i] !== PNG_MAGIC[i]) throw new Error('Invalid PNG magic bytes.')
    }
    const kept: Uint8Array[] = [bytes.subarray(0, 8)]
    let offset = 8
    let sawIhdr = false
    let sawIdat = false
    let sawIend = false

    while (offset < bytes.length) {
      if (sawIend || offset + 8 > bytes.length) throw new Error('Malformed PNG chunk framing.')
      const length = readUint32BE(bytes, offset)
      const typeChars = String.fromCharCode(
        bytes[offset + 4]!,
        bytes[offset + 5]!,
        bytes[offset + 6]!,
        bytes[offset + 7]!
      )
      const totalChunkBytes = 12 + length
      if (offset + totalChunkBytes > bytes.length) throw new Error('Truncated PNG chunk.')

      if (typeChars === 'IHDR') sawIhdr = true
      if (typeChars === 'IDAT' && length > 0) sawIdat = true
      if (typeChars === 'IEND') sawIend = true

      if (!FORBIDDEN_PNG_CHUNKS.has(typeChars.toLowerCase())) {
        kept.push(bytes.subarray(offset, offset + totalChunkBytes))
      }
      offset += totalChunkBytes
    }
    if (!sawIhdr || !sawIdat || !sawIend) throw new Error('Incomplete PNG stream.')
    return concatChunks(kept)
  }

  // WebP RIFF container
  if (
    bytes.length < 20 ||
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== 'RIFF' ||
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) !== 'WEBP'
  ) {
    throw new Error('Invalid WebP magic bytes.')
  }
  const declaredRiffSize = readUint32LE(bytes, 4)
  if (declaredRiffSize + 8 !== bytes.length) {
    throw new Error('Malformed WebP RIFF length.')
  }

  const subchunks: Uint8Array[] = []
  let offset = 12
  let sawBitstream = false

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Truncated WebP subchunk.')
    const fourcc = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!
    )
    const chunkSize = readUint32LE(bytes, offset + 4)
    const padded = chunkSize + (chunkSize % 2)
    if (offset + 8 + padded > bytes.length) throw new Error('Truncated WebP subchunk payload.')

    if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') {
      sawBitstream = true
    }

    if (!FORBIDDEN_WEBP_CHUNKS.has(fourcc.trim().toUpperCase())) {
      const copied = bytes.slice(offset, offset + 8 + padded)
      if (fourcc === 'VP8X' && chunkSize === 10) {
        // Clear EXIF (0x08) and XMP (0x04) feature flags when stripping metadata chunks.
        copied[8] = copied[8]! & ~0x0c
      }
      subchunks.push(copied)
    }
    offset += 8 + padded
  }

  if (!sawBitstream) throw new Error('Missing WebP bitstream.')
  const body = concatChunks(subchunks)
  const header = new Uint8Array(12)
  header.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  writeUint32LE(header, 4, 4 + body.length)
  header.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  return concatChunks([header, body])
}

export interface BoxBlurResult {
  blurred: Uint8ClampedArray
  hadSpatialVariance: boolean
  changedBytes: number
}

/**
 * Deterministic multi-pass 3x3 RGBA box-blur executed directly on downscaled pixel bytes so
 * browsers without `CanvasRenderingContext2D.filter` (Safari/iOS) still genuinely blur text/UI
 * and never fail open.
 */
export function boxBlurRgba(
  input: Uint8ClampedArray,
  width: number,
  height: number,
  passes = 2
): BoxBlurResult {
  const expectedLength = width * height * 4
  if (width < 1 || height < 1 || input.length !== expectedLength) {
    throw new Error('Invalid RGBA pixel buffer dimensions.')
  }

  let hadSpatialVariance = false
  const r0 = input[0]!
  const g0 = input[1]!
  const b0 = input[2]!
  const a0 = input[3]!
  for (let idx = 4; idx < expectedLength; idx += 4) {
    if (
      input[idx] !== r0 ||
      input[idx + 1] !== g0 ||
      input[idx + 2] !== b0 ||
      input[idx + 3] !== a0
    ) {
      hadSpatialVariance = true
      break
    }
  }

  let src = new Uint8ClampedArray(input)
  let dst = new Uint8ClampedArray(expectedLength)
  const totalPasses = Math.max(1, passes)

  for (let pass = 0; pass < totalPasses; pass++) {
    for (let y = 0; y < height; y++) {
      const yMin = Math.max(0, y - 1)
      const yMax = Math.min(height - 1, y + 1)
      for (let x = 0; x < width; x++) {
        const xMin = Math.max(0, x - 1)
        const xMax = Math.min(width - 1, x + 1)
        let rSum = 0
        let gSum = 0
        let bSum = 0
        let aSum = 0
        let samples = 0
        for (let ny = yMin; ny <= yMax; ny++) {
          for (let nx = xMin; nx <= xMax; nx++) {
            const p = (ny * width + nx) * 4
            rSum += src[p]!
            gSum += src[p + 1]!
            bSum += src[p + 2]!
            aSum += src[p + 3]!
            samples++
          }
        }
        const outOffset = (y * width + x) * 4
        dst[outOffset] = Math.round(rSum / samples)
        dst[outOffset + 1] = Math.round(gSum / samples)
        dst[outOffset + 2] = Math.round(bSum / samples)
        dst[outOffset + 3] = Math.round(aSum / samples)
      }
    }
    const swap = src
    src = dst
    dst = swap
  }

  let changedBytes = 0
  for (let i = 0; i < expectedLength; i++) {
    if (src[i] !== input[i]) changedBytes++
  }
  return { blurred: src, hadSpatialVariance, changedBytes }
}

export interface BlurredScreenshotAttachment {
  contentType: BugScreenshotContentType
  blurred: true
  dataBase64: string
  previewObjectUrl: string
  byteLength: number
}

export function revokeScreenshotPreview(attachment: BlurredScreenshotAttachment | undefined): void {
  if (
    attachment !== undefined &&
    attachment.previewObjectUrl.startsWith('blob:') &&
    typeof URL !== 'undefined' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    URL.revokeObjectURL(attachment.previewObjectUrl)
  }
}

async function decodeImageDimensions(
  blob: Blob
): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  }
  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('Image could not be decoded.'))
      element.src = objectUrl
    })
    return {
      source: img,
      width: img.naturalWidth || img.width || 320,
      height: img.naturalHeight || img.height || 240,
      release: () => URL.revokeObjectURL(objectUrl),
    }
  } catch (err) {
    URL.revokeObjectURL(objectUrl)
    throw err
  }
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: BugScreenshotContentType,
  quality?: number
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) resolve(result)
        else reject(new Error('Canvas encoding failed.'))
      },
      mimeType,
      quality
    )
  })
}

function arraysEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Render an uploaded image through a deterministic downscale + 3x3 pixel box-blur + upscale
 * pipeline (layered with `ctx.filter = 'blur(12px)'` when supported), verify fail-closed pixel
 * modification on non-uniform images, strip metadata chunks, and issue a revocable `blob:` URL.
 */
export async function blurScreenshotFile(file: Blob): Promise<BlurredScreenshotAttachment> {
  const decoded = await decodeImageDimensions(file)
  try {
    const scales = [1280, 960, 640, 480]
    for (const maxEdge of scales) {
      const ratio = Math.min(1, maxEdge / Math.max(1, decoded.width, decoded.height))
      const width = Math.max(1, Math.round(decoded.width * ratio))
      const height = Math.max(1, Math.round(decoded.height * ratio))

      const smallW = Math.max(8, Math.round(width / BLUR_DOWNSCALE_DIVISOR))
      const smallH = Math.max(8, Math.round(height / BLUR_DOWNSCALE_DIVISOR))
      const stageCanvas = document.createElement('canvas')
      stageCanvas.width = smallW
      stageCanvas.height = smallH
      const stageCtx = stageCanvas.getContext('2d')
      if (
        !stageCtx ||
        typeof stageCtx.getImageData !== 'function' ||
        typeof stageCtx.putImageData !== 'function'
      ) {
        throw new Error('2D canvas pixel pipeline unavailable.')
      }

      stageCtx.imageSmoothingEnabled = true
      stageCtx.imageSmoothingQuality = 'high'
      if (typeof stageCtx.filter === 'string') {
        stageCtx.filter = 'blur(2px)'
      }
      stageCtx.drawImage(decoded.source, 0, 0, smallW, smallH)

      const stageImageData = stageCtx.getImageData(0, 0, smallW, smallH)
      const originalStageBytes = new Uint8ClampedArray(stageImageData.data)
      const { blurred, hadSpatialVariance, changedBytes } = boxBlurRgba(
        originalStageBytes,
        smallW,
        smallH,
        2
      )
      if (hadSpatialVariance && changedBytes === 0) {
        throw new Error('Canvas pixel blur failed closed.')
      }
      stageImageData.data.set(blurred)
      stageCtx.putImageData(stageImageData, 0, 0)

      const readbackStage = stageCtx.getImageData(0, 0, smallW, smallH)
      if (hadSpatialVariance && arraysEqual(readbackStage.data, originalStageBytes)) {
        throw new Error('Canvas pixel writeback verification failed closed.')
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D canvas context unavailable.')

      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      if (typeof ctx.filter === 'string') {
        ctx.filter = BLUR_CSS_FILTER
      }
      ctx.drawImage(stageCanvas, 0, 0, smallW, smallH, 0, 0, width, height)

      for (const candidateType of ['image/webp', 'image/png'] as const) {
        const blob = await canvasToBlob(
          canvas,
          candidateType,
          candidateType === 'image/webp' ? 0.78 : undefined
        )
        const actualType: BugScreenshotContentType =
          blob.type === 'image/webp' ? 'image/webp' : 'image/png'
        const rawBytes = new Uint8Array(await blob.arrayBuffer())
        if (rawBytes.length > MAX_SCREENSHOT_BYTES) continue

        const cleanBytes = stripAndValidateImageBytes(rawBytes, actualType)
        const dataBase64 = bytesToBase64(cleanBytes)
        const previewObjectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(cleanBytes)], { type: actualType })
        )
        return {
          contentType: actualType,
          blurred: true,
          dataBase64,
          previewObjectUrl,
          byteLength: cleanBytes.length,
        }
      }
    }
    throw new Error('Screenshot exceeds 256 KiB even after blurring and downscaling.')
  } finally {
    decoded.release()
  }
}

export interface BuildBugReportPayloadOptions {
  buildId: string
  component: BugComponent
  errorCode: string
  deviceClass: BugDeviceClass
  consent: boolean
  sanitizedNote: string
  attachment?: BlurredScreenshotAttachment | undefined
}

export function buildOutgoingBugReportPayload(
  options: BuildBugReportPayloadOptions
): components['schemas']['BugReportCreateRequest'] {
  const payload: components['schemas']['BugReportCreateRequest'] = {
    build_id: options.buildId,
    component: options.component,
    error_code: options.errorCode,
    device_class: options.deviceClass,
    consent: options.consent,
  }
  if (options.sanitizedNote !== '') {
    payload.note = options.sanitizedNote
  }
  if (options.attachment !== undefined) {
    payload.screenshot = {
      contentType: options.attachment.contentType,
      blurred: true,
      dataBase64: options.attachment.dataBase64,
    }
  }
  return payload
}
