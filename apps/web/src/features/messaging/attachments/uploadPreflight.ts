// What may be attached to a message, checked on this device before anything is sent
// (docs/specs/messaging-media-and-notifications.md). The contract (Core API 0.43.0,
// `AttachmentUploadRequest`) names the types it accepts and the 25 MiB ceiling; this module refuses
// the rest before a byte leaves, and says why in words the member can act on.
//
// Active content is refused whatever type the browser reports: a page, a script or an SVG can run
// in the reader's browser, so its name alone is enough to refuse it. A file that claims to be an
// image or a PDF must also start like one: a renamed page is refused even under an innocent name.

/** The contract's ceiling: 25 MiB. */
export const MAX_ATTACHMENT_BYTES = 26_214_400

/** At most this many files wait in the composer at once. */
export const MAX_PENDING_ATTACHMENTS = 10

/** The types the contract accepts. */
export const ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/octet-stream',
] as const

export type AttachmentType = (typeof ATTACHMENT_TYPES)[number]

/** Extensions refused outright: what a browser, an OS or an office suite may run. */
const ACTIVE_EXTENSIONS = new Set([
  'htm',
  'html',
  'xhtml',
  'shtml',
  'mht',
  'mhtml',
  'svg',
  'svgz',
  'xml',
  'xsl',
  'xslt',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'wasm',
  'swf',
  'hta',
  'exe',
  'msi',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'vbs',
  'jar',
  'apk',
  'app',
  'dmg',
  'sh',
  'lnk',
  'docm',
  'xlsm',
  'pptm',
])

/** Types refused outright, whatever the name says. */
const ACTIVE_TYPES =
  /^(text\/(html|xml|javascript|ecmascript)|application\/(xhtml\+xml|xml|javascript|ecmascript|x-javascript|wasm|x-msdownload|java-archive)|image\/svg\+xml)(;|$)/iu

export type PreflightRefusal = 'empty' | 'too-large' | 'active-content' | 'type-mismatch'

export type Preflight =
  | { ok: true; filename: string; contentType: AttachmentType; sizeBytes: number }
  | { ok: false; reason: PreflightRefusal }

/** A name safe to send and to show: no path, no control or direction character, at most 255. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const visible = base.replace(/[\u0000-\u001f\u007f\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '')
  const trimmed = visible.trim().replace(/^\.+/u, '')
  const name255 = [...trimmed].slice(0, 255).join('')
  return name255 === '' ? 'file' : name255
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Every extension in the name: « rapport.html.pdf » carries an active one too. */
function extensionsOf(name: string): string[] {
  return name.toLowerCase().split('.').slice(1)
}

/** The type the contract will hear: the reported one when accepted, otherwise opaque bytes. */
function contractTypeOf(reported: string, name: string): AttachmentType {
  const type = reported.toLowerCase().split(';')[0]!.trim()
  if ((ATTACHMENT_TYPES as readonly string[]).includes(type)) return type as AttachmentType
  const ext = extensionOf(name)
  if (ext === 'txt' || ext === 'md' || ext === 'csv') return 'text/plain'
  return 'application/octet-stream'
}

/** How the types the device checks start. */
const SIGNATURES: Partial<Record<AttachmentType, (bytes: Uint8Array) => boolean>> = {
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'application/pdf': (b) => ascii(b, 0, 5) === '%PDF-',
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.slice(from, to))
}

/** Text that is markup a browser would run, sniffed from the first bytes. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 512))
    .replace(/^\uFEFF/u, '')
    .trimStart()
    .toLowerCase()
  return /^<(!doctype|html|svg|script|\?xml|head|body|iframe)/u.test(head)
}

/** The checks on what the member chose, its first bytes included (at most 512 are read). */
export function preflight(
  file: { name: string; type: string; size: number },
  head: Uint8Array
): Preflight {
  if (file.size <= 0) return { ok: false, reason: 'empty' }
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too-large' }
  const filename = cleanFilename(file.name)
  if (
    ACTIVE_TYPES.test(file.type) ||
    extensionsOf(filename).some((ext) => ACTIVE_EXTENSIONS.has(ext))
  ) {
    return { ok: false, reason: 'active-content' }
  }
  const contentType = contractTypeOf(file.type, filename)
  const signature = SIGNATURES[contentType]
  if (signature !== undefined && !signature(head)) return { ok: false, reason: 'type-mismatch' }
  if (signature === undefined && looksLikeMarkup(head))
    return { ok: false, reason: 'active-content' }
  return { ok: true, filename, contentType, sizeBytes: file.size }
}

/** The first bytes of a file, for `preflight`. */
export async function headOf(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 512).arrayBuffer())
}
