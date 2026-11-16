// Preparing a picture before it becomes a member's avatar: the browser does the work, so a photo
// straight off a phone never leaves as fifteen megabytes. The result is a square PNG of at most
// `AVATAR_SIDE` pixels, centre-cropped — the shape every avatar is drawn in.

/** What a profile picture is reduced to: a square of this many pixels on a side. */
export const AVATAR_SIDE = 256
/** The largest file accepted before anything is decoded: 2 MB. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024
/** The image formats accepted. Never SVG: an SVG is a document that can carry script. */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type AvatarProblem = 'type' | 'size' | 'decode'

export class AvatarRefused extends Error {
  readonly reason: AvatarProblem
  constructor(reason: AvatarProblem) {
    super(`avatar refused: ${reason}`)
    this.name = 'AvatarRefused'
    this.reason = reason
  }
}

/** Whether a file may be decoded at all, by its declared type and its size — before decoding it. */
export function checkAvatarFile(file: File): AvatarProblem | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return 'type'
  if (file.size > MAX_AVATAR_BYTES) return 'size'
  return null
}

/**
 * The square, resized PNG to upload. Decoding happens in the browser's own image pipeline
 * (`createImageBitmap`), which refuses anything that is not an image, and the bytes that leave are
 * the ones the canvas re-encoded — never the file's own, so no metadata travels with the picture.
 */
export async function squareAvatarPng(file: File): Promise<Blob> {
  const refusal = checkAvatarFile(file)
  if (refusal !== null) throw new AvatarRefused(refusal)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AvatarRefused('decode')
  }
  try {
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
