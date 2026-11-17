import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AVATAR_SIDE,
  AvatarRefused,
  inspectRasterImage,
  MAX_AVATAR_BYTES,
  squareAvatarPng,
} from './avatarImage'

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13, false)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // IHDR
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  bytes[24] = 8 // bit depth
  bytes[25] = 6 // RGBA
  return bytes
}

function jpegWithApp1AndSof(
  marker: number,
  width: number,
  height: number,
  app1PayloadBytes = 128
): Uint8Array<ArrayBuffer> {
  const app1Length = 2 + app1PayloadBytes
  const sofLength = 17
  const bytes = new Uint8Array(2 + 2 + app1Length + 2 + sofLength + 2)
  const view = new DataView(bytes.buffer)
  let offset = 0
  // SOI
  bytes[offset++] = 0xff
  bytes[offset++] = 0xd8
  // APP1 (simulates EXIF header preceding SOF beyond byte 64)
  bytes[offset++] = 0xff
  bytes[offset++] = 0xe1
  view.setUint16(offset, app1Length, false)
  offset += app1Length
  // SOFn
  bytes[offset++] = 0xff
  bytes[offset++] = marker
  view.setUint16(offset, sofLength, false)
  bytes[offset + 2] = 8 // precision
  view.setUint16(offset + 3, height, false)
  view.setUint16(offset + 5, width, false)
  offset += sofLength
  // EOI
  bytes[offset] = 0xff
  bytes[offset + 1] = 0xd9
  return bytes
}

function webpVp8LossyHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30)
  const view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  view.setUint32(4, 22, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x20], 12) // 'VP8 '
  view.setUint32(16, 10, true)
  bytes[20] = 0x00 // keyframe
  bytes.set([0x9d, 0x01, 0x2a], 23)
  view.setUint16(26, width & 0x3fff, true)
  view.setUint16(28, height & 0x3fff, true)
  return bytes
}

function webpVp8LosslessHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(25)
  const view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, 17, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12) // VP8L
  view.setUint32(16, 5, true)
  bytes[20] = 0x2f
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  view.setUint32(21, packed >>> 0, true)
  return bytes
}

function webpVp8xHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30)
  const view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, 22, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  view.setUint32(16, 10, true)
  const w = width - 1
  const h = height - 1
  bytes[24] = w & 0xff
  bytes[25] = (w >>> 8) & 0xff
  bytes[26] = (w >>> 16) & 0xff
  bytes[27] = h & 0xff
  bytes[28] = (h >>> 8) & 0xff
  bytes[29] = (h >>> 16) & 0xff
  return bytes
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('avatarImage decompression-bomb and raster-magic guard', () => {
  it('rejects a crafted 32768x32768 PNG header BEFORE calling createImageBitmap', async () => {
    const decodeSpy = vi.fn()
    vi.stubGlobal('createImageBitmap', decodeSpy)

    const bomb = new File([pngHeader(32768, 32768)], 'bomb.png', { type: 'image/png' })
    await expect(squareAvatarPng(bomb)).rejects.toMatchObject({
      name: 'AvatarRefused',
      reason: 'size',
    })
    expect(decodeSpy).not.toHaveBeenCalled()
  })

  it('rejects a fake-extension SVG disguised as image/png BEFORE calling createImageBitmap', async () => {
    const decodeSpy = vi.fn()
    vi.stubGlobal('createImageBitmap', decodeSpy)

    const disguisedSvg = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
      'avatar.png',
      { type: 'image/png' }
    )
    await expect(squareAvatarPng(disguisedSvg)).rejects.toMatchObject({
      name: 'AvatarRefused',
      reason: 'type',
    })
    expect(decodeSpy).not.toHaveBeenCalled()
  })

  it('rejects declared image/svg+xml and files larger than MAX_AVATAR_BYTES immediately', async () => {
    const svg = new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' })
    await expect(squareAvatarPng(svg)).rejects.toMatchObject({ reason: 'type' })

    const huge = new File([new Uint8Array(MAX_AVATAR_BYTES + 1)], 'huge.png', {
      type: 'image/png',
    })
    await expect(squareAvatarPng(huge)).rejects.toMatchObject({ reason: 'size' })
  })

  it('parses intrinsic dimensions across PNG IHDR, JPEG SOF0/SOF1/SOF2 (past EXIF), and WebP VP8/VP8L/VP8X', () => {
    expect(inspectRasterImage(pngHeader(512, 256))).toEqual({
      ok: true,
      mime: 'image/png',
      width: 512,
      height: 256,
    })
    expect(inspectRasterImage(pngHeader(0, 256))).toEqual({ ok: false, reason: 'decode' })
    expect(inspectRasterImage(pngHeader(4097, 100))).toEqual({ ok: false, reason: 'size' })

    expect(inspectRasterImage(jpegWithApp1AndSof(0xc0, 1024, 768, 512))).toEqual({
      ok: true,
      mime: 'image/jpeg',
      width: 1024,
      height: 768,
    })
    expect(inspectRasterImage(jpegWithApp1AndSof(0xc2, 8192, 8192, 256))).toEqual({
      ok: false,
      reason: 'size',
    })

    expect(inspectRasterImage(webpVp8LossyHeader(640, 480))).toEqual({
      ok: true,
      mime: 'image/webp',
      width: 640,
      height: 480,
    })
    expect(inspectRasterImage(webpVp8LosslessHeader(4096, 4096))).toEqual({
      ok: true,
      mime: 'image/webp',
      width: 4096,
      height: 4096,
    })
    expect(inspectRasterImage(webpVp8LosslessHeader(4097, 4096))).toEqual({
      ok: false,
      reason: 'size',
    })
    expect(inspectRasterImage(webpVp8xHeader(16384, 16384))).toEqual({
      ok: false,
      reason: 'size',
    })
  })

  it('crops and re-encodes a valid raster image to AVATAR_SIDE PNG and closes the bitmap', async () => {
    const closeSpy = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 400,
        height: 200,
        close: closeSpy,
      }))
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
      cb(new Blob([pngHeader(AVATAR_SIDE, AVATAR_SIDE)], { type: 'image/png' }))
    })

    const valid = new File([pngHeader(400, 200)], 'photo.png', { type: 'image/png' })
    const out = await squareAvatarPng(valid)
    expect(out.type).toBe('image/png')
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      100,
      0,
      200,
      200,
      0,
      0,
      AVATAR_SIDE,
      AVATAR_SIDE
    )
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(AvatarRefused).toBeDefined()
  })
})
