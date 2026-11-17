// Preparing a picture before it becomes a member's avatar: the browser does the work, so a photo
// straight off a phone never leaves as fifteen megabytes. The result is a square PNG of at most
// `AVATAR_SIDE` pixels, centre-cropped — the shape every avatar is drawn in.

/** What a profile picture is reduced to: a square of this many pixels on a side. */
export const AVATAR_SIDE = 256
/** The largest file accepted before anything is decoded: 2 MB. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024
/** Intrinsic width and height ceiling checked from the header before pixel allocation. */
export const MAX_AVATAR_DIMENSION = 4096
/** Total decoded pixel ceiling (`4096 * 4096`) guarding against decompression bombs. */
export const MAX_AVATAR_PIXELS = 16_777_216
/** The image formats accepted. Never SVG: an SVG is a document that can carry script. */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type AvatarMime = (typeof AVATAR_TYPES)[number]
export type AvatarProblem = 'type' | 'size' | 'decode'

export class AvatarRefused extends Error {
  readonly reason: AvatarProblem
  constructor(reason: AvatarProblem) {
    super(`avatar refused: ${reason}`)
    this.name = 'AvatarRefused'
    this.reason = reason
  }
}

export type RasterInspection =
  | {
      readonly ok: true
      readonly mime: AvatarMime
      readonly width: number
      readonly height: number
    }
  | { readonly ok: false; readonly reason: AvatarProblem }

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

function matchesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.byteLength) return false
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected[i]) return false
  }
  return true
}

function ascii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  )
}

function checkDimensions(width: number, height: number): AvatarProblem | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'decode'
  }
  if (
    width > MAX_AVATAR_DIMENSION ||
    height > MAX_AVATAR_DIMENSION ||
    width * height > MAX_AVATAR_PIXELS
  ) {
    return 'size'
  }
  return null
}

/** Verifies magic bytes only (`PNG`, `JPEG`, `WebP`), returning `null` for SVG or any other payload. */
export function sniffRasterMime(bytes: Uint8Array): AvatarMime | null {
  if (matchesAt(bytes, 0, PNG_MAGIC)) return 'image/png'
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.byteLength >= 12 && ascii4(bytes, 0) === 'RIFF' && ascii4(bytes, 8) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

function isJpegSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 && // DHT
    marker !== 0xc8 && // JPG
    marker !== 0xcc // DAC
  )
}

function inspectPng(bytes: Uint8Array, view: DataView): RasterInspection {
  if (bytes.byteLength < 24) return { ok: false, reason: 'decode' }
  const ihdrLength = view.getUint32(8, false)
  if (ihdrLength < 13 || ascii4(bytes, 12) !== 'IHDR') {
    return { ok: false, reason: 'decode' }
  }
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  const problem = checkDimensions(width, height)
  if (problem !== null) return { ok: false, reason: problem }
  return { ok: true, mime: 'image/png', width, height }
}

function inspectWebp(bytes: Uint8Array, view: DataView): RasterInspection {
  if (bytes.byteLength < 20) return { ok: false, reason: 'decode' }
  let offset = 12
  let width = 0
  let height = 0
  let found = false
  while (offset + 8 <= bytes.byteLength) {
    const fourcc = ascii4(bytes, offset)
    const chunkSize = view.getUint32(offset + 4, true)
    const payload = offset + 8
    if (fourcc === 'VP8X') {
      if (chunkSize < 10 || payload + 10 > bytes.byteLength) {
        return { ok: false, reason: 'decode' }
      }
      const w =
        ((bytes[payload + 4] ?? 0) |
          ((bytes[payload + 5] ?? 0) << 8) |
          ((bytes[payload + 6] ?? 0) << 16)) +
        1
      const h =
        ((bytes[payload + 7] ?? 0) |
          ((bytes[payload + 8] ?? 0) << 8) |
          ((bytes[payload + 9] ?? 0) << 16)) +
        1
      const problem = checkDimensions(w, h)
      if (problem !== null) return { ok: false, reason: problem }
      if (!found) {
        width = w
        height = h
        found = true
      }
    } else if (fourcc === 'VP8 ') {
      if (chunkSize < 10 || payload + 10 > bytes.byteLength) {
        return { ok: false, reason: 'decode' }
      }
      if (
        ((bytes[payload] ?? 1) & 1) !== 0 ||
        bytes[payload + 3] !== 0x9d ||
        bytes[payload + 4] !== 0x01 ||
        bytes[payload + 5] !== 0x2a
      ) {
        return { ok: false, reason: 'decode' }
      }
      const w = view.getUint16(payload + 6, true) & 0x3fff
      const h = view.getUint16(payload + 8, true) & 0x3fff
      const problem = checkDimensions(w, h)
      if (problem !== null) return { ok: false, reason: problem }
      if (!found) {
        width = w
        height = h
        found = true
      }
    } else if (fourcc === 'VP8L') {
      if (chunkSize < 5 || payload + 5 > bytes.byteLength) {
        return { ok: false, reason: 'decode' }
      }
      if (bytes[payload] !== 0x2f) return { ok: false, reason: 'decode' }
      const bits = view.getUint32(payload + 1, true)
      const w = (bits & 0x3fff) + 1
      const h = ((bits >>> 14) & 0x3fff) + 1
      const problem = checkDimensions(w, h)
      if (problem !== null) return { ok: false, reason: problem }
      if (!found) {
        width = w
        height = h
        found = true
      }
    }
    if (payload + chunkSize > bytes.byteLength) break
    offset = payload + chunkSize + (chunkSize & 1)
  }
  if (!found) return { ok: false, reason: 'decode' }
  return { ok: true, mime: 'image/webp', width, height }
}

function inspectJpeg(bytes: Uint8Array, view: DataView): RasterInspection {
  let offset = 2
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return { ok: false, reason: 'decode' }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) return { ok: false, reason: 'decode' }
    const marker = bytes[offset]!
    offset += 1
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return { ok: false, reason: 'decode' }
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > bytes.byteLength) return { ok: false, reason: 'decode' }
    const segmentLength = view.getUint16(offset, false)
    if (segmentLength < 2) return { ok: false, reason: 'decode' }
    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.byteLength) {
        return { ok: false, reason: 'decode' }
      }
      const height = view.getUint16(offset + 3, false)
      const width = view.getUint16(offset + 5, false)
      const problem = checkDimensions(width, height)
      if (problem !== null) return { ok: false, reason: problem }
      return { ok: true, mime: 'image/jpeg', width, height }
    }
    if (offset + segmentLength > bytes.byteLength) return { ok: false, reason: 'decode' }
    offset += segmentLength
  }
  return { ok: false, reason: 'decode' }
}

/**
 * Verifies raster magic bytes (`PNG`, `JPEG`, `WebP`) and parses intrinsic header dimensions
 * before any image decoder allocates pixel memory.
 */
export function inspectRasterImage(bytes: Uint8Array): RasterInspection {
  const mime = sniffRasterMime(bytes)
  if (mime === null) return { ok: false, reason: 'type' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (mime) {
    case 'image/png':
      return inspectPng(bytes, view)
    case 'image/webp':
      return inspectWebp(bytes, view)
    case 'image/jpeg':
      return inspectJpeg(bytes, view)
  }
}

/** Whether a file may be decoded at all, by its declared type and its size — before decoding it. */
export function checkAvatarFile(file: File): AvatarProblem | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return 'type'
  if (file.size > MAX_AVATAR_BYTES) return 'size'
  return null
}

/**
 * The square, resized PNG to upload. Header magic bytes and dimensions are verified before
 * `createImageBitmap` runs so decompression bombs and disguised SVGs never reach the decoder,
 * and the bytes that leave are re-encoded by the canvas so no metadata travels with the picture.
 */
export async function squareAvatarPng(file: File): Promise<Blob> {
  const refusal = checkAvatarFile(file)
  if (refusal !== null) throw new AvatarRefused(refusal)
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const buffer =
      typeof file.arrayBuffer === 'function'
        ? await file.arrayBuffer()
        : await new Response(file).arrayBuffer()
    bytes = new Uint8Array(buffer)
  } catch {
    throw new AvatarRefused('decode')
  }
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw new AvatarRefused('size')
  const header = inspectRasterImage(bytes)
  if (!header.ok) throw new AvatarRefused(header.reason)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: header.mime }))
  } catch {
    throw new AvatarRefused('decode')
  }
  try {
    const decodedProblem = checkDimensions(bitmap.width, bitmap.height)
    if (decodedProblem !== null) throw new AvatarRefused(decodedProblem)
    const side = Math.min(bitmap.width, bitmap.height)
    if (side === 0) throw new AvatarRefused('decode')
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIDE
    canvas.height = AVATAR_SIDE
    const context = canvas.getContext('2d')
    if (context === null) throw new AvatarRefused('decode')
    context.drawImage(
      bitmap,
      // The centre square of the picture: what a round avatar shows of it anyway.
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIDE,
      AVATAR_SIDE
    )
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (blob === null) throw new AvatarRefused('decode')
    return blob
  } finally {
    bitmap.close()
  }
}
