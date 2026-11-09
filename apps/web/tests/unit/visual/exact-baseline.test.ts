// @vitest-environment node

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  assertExactBaseline,
  BASELINE_DIR,
  compareDecoded,
  CORNER_AA_PIXELS_BY_BASELINE,
  decodePng,
  differingPixels,
  encodePng,
  MAX_CORNER_AA_CHANNEL_DELTA,
  MAX_CORNER_AA_PIXELS,
} from '../../visual/support/exactBaseline'

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

function chunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length, 0)
  header.write(type, 4, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4, 8), body])) >>> 0, 0)
  return Buffer.concat([header, body, crc])
}

function ihdrChunk(
  width: number,
  height: number,
  depth = 8,
  colour = 6,
  compression = 0,
  filterMethod = 0,
  interlace = 0
): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = depth
  ihdr[9] = colour
  ihdr[10] = compression
  ihdr[11] = filterMethod
  ihdr[12] = interlace
  return chunk('IHDR', ihdr)
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft
  const pa = Math.abs(p - left)
  const pb = Math.abs(p - up)
  const pc = Math.abs(p - upLeft)
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
}

function encodeCustomPng(options: {
  width: number
  height: number
  channels: 3 | 4
  pixels: Uint8Array
  rowFilters: readonly number[]
  idatSplits?: number
}): Buffer {
  const { width, height, channels, pixels, rowFilters, idatSplits = 1 } = options
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const filter = rowFilters[y] ?? 0
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const cur = pixels[y * stride + x]!
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) predictor = paethPredictor(left, up, upLeft)
      raw[y * (stride + 1) + 1 + x] = (cur - predictor) & 0xff
    }
  }
  const compressed = deflateSync(raw)
  const idatChunks: Buffer[] = []
  const partSize = Math.max(1, Math.ceil(compressed.length / idatSplits))
  for (let offset = 0; offset < compressed.length; offset += partSize) {
    idatChunks.push(chunk('IDAT', compressed.subarray(offset, offset + partSize)))
  }
  return Buffer.concat([
    SIGNATURE,
    ihdrChunk(width, height, 8, channels === 4 ? 6 : 2),
    ...idatChunks,
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('exactBaseline PNG decoding and bounded corner-AA comparator', () => {
  it('decodes all five PNG scanline filters (None, Sub, Up, Average, Paeth) across multi-chunk IDAT for RGBA and RGB', () => {
    const width = 4
    const height = 5
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < rgba.length; i++) {
      rgba[i] = (i * 37 + 19) & 0xff
    }
    const pngRgba = encodeCustomPng({
      width,
      height,
      channels: 4,
      pixels: rgba,
      rowFilters: [0, 1, 2, 3, 4],
      idatSplits: 3,
    })
    const decodedRgba = decodePng(pngRgba)
    expect(decodedRgba.width).toBe(width)
    expect(decodedRgba.height).toBe(height)
    expect(Array.from(decodedRgba.rgba)).toEqual(Array.from(rgba))

    const rgb = new Uint8Array(width * height * 3)
    const expectedFromRgb = new Uint8Array(width * height * 4)
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgb[i] = (i * 53 + 7) & 0xff
      rgb[i + 1] = (i * 29 + 101) & 0xff
      rgb[i + 2] = (i * 71 + 211) & 0xff
      expectedFromRgb[j] = rgb[i]!
      expectedFromRgb[j + 1] = rgb[i + 1]!
      expectedFromRgb[j + 2] = rgb[i + 2]!
      expectedFromRgb[j + 3] = 255
    }
    const pngRgb = encodeCustomPng({
      width,
      height,
      channels: 3,
      pixels: rgb,
      rowFilters: [4, 3, 2, 1, 0],
      idatSplits: 2,
    })
    const decodedRgb = decodePng(pngRgb)
    expect(decodedRgb.width).toBe(width)
    expect(decodedRgb.height).toBe(height)
    expect(Array.from(decodedRgb.rgba)).toEqual(Array.from(expectedFromRgb))
  })

  it('rejects malformed or unsupported PNG structures rather than mis-decoding pixels', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('not a PNG')
    expect(() => decodePng(Buffer.concat([SIGNATURE, Buffer.alloc(4)]))).toThrow(
      'truncated PNG chunk'
    )
    const badLengthHeader = Buffer.alloc(12)
    badLengthHeader.writeUInt32BE(50, 0)
    badLengthHeader.write('IHDR', 4, 4, 'latin1')
    expect(() => decodePng(Buffer.concat([SIGNATURE, badLengthHeader]))).toThrow(
      'truncated PNG chunk'
    )
    expect(() =>
      decodePng(
        Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(10)), chunk('IEND', Buffer.alloc(0))])
      )
    ).toThrow('invalid IHDR length 10')
    expect(() =>
      decodePng(Buffer.concat([SIGNATURE, ihdrChunk(0, 4), chunk('IEND', Buffer.alloc(0))]))
    ).toThrow('unsupported PNG: 0x4')
    expect(() =>
      decodePng(Buffer.concat([SIGNATURE, ihdrChunk(4, 4, 16, 6), chunk('IEND', Buffer.alloc(0))]))
    ).toThrow('depth 16')
    expect(() =>
      decodePng(Buffer.concat([SIGNATURE, ihdrChunk(4, 4, 8, 3), chunk('IEND', Buffer.alloc(0))]))
    ).toThrow('colour type 3')
    expect(() =>
      decodePng(
        Buffer.concat([SIGNATURE, ihdrChunk(4, 4, 8, 6, 1, 0, 0), chunk('IEND', Buffer.alloc(0))])
      )
    ).toThrow('compression 1')
    expect(() =>
      decodePng(
        Buffer.concat([SIGNATURE, ihdrChunk(4, 4, 8, 6, 0, 1, 0), chunk('IEND', Buffer.alloc(0))])
      )
    ).toThrow('filter 1')
    expect(() =>
      decodePng(
        Buffer.concat([SIGNATURE, ihdrChunk(4, 4, 8, 6, 0, 0, 1), chunk('IEND', Buffer.alloc(0))])
      )
    ).toThrow('interlace 1')
    expect(() =>
      decodePng(
        Buffer.concat([
          SIGNATURE,
          ihdrChunk(2, 2, 8, 2),
          chunk('tRNS', Buffer.alloc(6)),
          chunk('IEND', Buffer.alloc(0)),
        ])
      )
    ).toThrow('unsupported PNG: tRNS chunk')
    expect(() =>
      decodePng(Buffer.concat([SIGNATURE, ihdrChunk(2, 2, 8, 6), chunk('IEND', Buffer.alloc(0))]))
    ).toThrow('incomplete PNG: missing IHDR, IDAT, or IEND')
    expect(() =>
      decodePng(
        Buffer.concat([
          SIGNATURE,
          ihdrChunk(1, 1, 8, 6),
          chunk('IDAT', deflateSync(Buffer.from([0, 1, 2]))),
          chunk('IEND', Buffer.alloc(0)),
        ])
      )
    ).toThrow('unexpected inflated PNG length 3, expected 5')
    expect(() =>
      decodePng(
        Buffer.concat([
          SIGNATURE,
          ihdrChunk(1, 1, 8, 6),
          chunk('IDAT', deflateSync(Buffer.from([5, 0, 0, 0, 255]))),
          chunk('IEND', Buffer.alloc(0)),
        ])
      )
    ).toThrow('unknown PNG filter 5')
  })

  it('enforces the 24-pixel / 2-unit corner-AA bound and writes -exact-actual.png only on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exact-baseline-'))
    try {
      const width = 10
      const height = 4
      const baseRgba = new Uint8Array(width * height * 4).fill(120)
      const baseline = encodePng({ width, height, rgba: baseRgba })

      const withPixelDeltas = (shifts: readonly { pixel: number; delta: number }[]): Buffer => {
        const next = new Uint8Array(baseRgba)
        for (const { pixel, delta } of shifts) {
          next[pixel * 4] = next[pixel * 4]! + delta
        }
        return encodePng({ width, height, rgba: next })
      }

      const exactPass = assertExactBaseline(baseline, baseline, 'same.png', (f) => join(dir, f))
      expect(exactPass.passes).toBe(true)
      expect(exactPass.differingPixels).toBe(0)
      expect(existsSync(join(dir, 'same-exact-actual.png'))).toBe(false)

      const boundaryPassBytes = withPixelDeltas(
        Array.from({ length: MAX_CORNER_AA_PIXELS }, (_, i) => ({
          pixel: i,
          delta: i % 2 === 0 ? 1 : MAX_CORNER_AA_CHANNEL_DELTA,
        }))
      )
      const boundaryPass = assertExactBaseline(
        boundaryPassBytes,
        baseline,
        'corner-pass.png',
        (f) => join(dir, f)
      )
      expect(boundaryPass).toEqual({
        sameSize: true,
        differingPixels: MAX_CORNER_AA_PIXELS,
        loudPixels: 0,
        maxChannelDelta: MAX_CORNER_AA_CHANNEL_DELTA,
        passes: true,
      })
      expect(differingPixels(decodePng(boundaryPassBytes), decodePng(baseline))).toBe(
        MAX_CORNER_AA_PIXELS
      )
      expect(existsSync(join(dir, 'corner-pass-exact-actual.png'))).toBe(false)

      const loudBytes = withPixelDeltas([{ pixel: 0, delta: MAX_CORNER_AA_CHANNEL_DELTA + 1 }])
      expect(() =>
        assertExactBaseline(loudBytes, baseline, 'loud.png', (f) => join(dir, f))
      ).toThrow(/1 pixel\(s\) differ \(max channel delta 3, 1 pixel\(s\) with channel delta > 2/)
      expect(readFileSync(join(dir, 'loud-exact-actual.png')).equals(loudBytes)).toBe(true)

      const tooManyBytes = withPixelDeltas(
        Array.from({ length: MAX_CORNER_AA_PIXELS + 1 }, (_, i) => ({ pixel: i, delta: 1 }))
      )
      expect(() =>
        assertExactBaseline(tooManyBytes, baseline, 'count.png', (f) => join(dir, f))
      ).toThrow(/25 pixel\(s\) differ \(max channel delta 1, 0 pixel\(s\) with channel delta > 2/)
      expect(readFileSync(join(dir, 'count-exact-actual.png')).equals(tooManyBytes)).toBe(true)

      const wrongSizeBytes = encodePng({
        width: width - 1,
        height,
        rgba: baseRgba.subarray(0, (width - 1) * height * 4),
      })
      expect(compareDecoded(decodePng(wrongSizeBytes), decodePng(baseline)).sameSize).toBe(false)
      expect(differingPixels(decodePng(wrongSizeBytes), decodePng(baseline))).toBe(-1)
      expect(() =>
        assertExactBaseline(wrongSizeBytes, baseline, 'size.png', (f) => join(dir, f))
      ).toThrow(/a different size/)
      expect(readFileSync(join(dir, 'size-exact-actual.png')).equals(wrongSizeBytes)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives order-dark.png alone a count of 48, and every other baseline 24', () => {
    // A count of its own is a measured exception: the list is pinned, and names real baselines.
    expect(CORNER_AA_PIXELS_BY_BASELINE).toEqual({ 'order-dark.png': 48 })
    for (const name of Object.keys(CORNER_AA_PIXELS_BY_BASELINE)) {
      expect(existsSync(join(BASELINE_DIR, name))).toBe(true)
    }
    const dir = mkdtempSync(join(tmpdir(), 'exact-baseline-'))
    try {
      const width = 10
      const height = 5
      const baseRgba = new Uint8Array(width * height * 4).fill(120)
      const baseline = encodePng({ width, height, rgba: baseRgba })
      const shifted = (count: number): Buffer => {
        const next = new Uint8Array(baseRgba)
        for (let pixel = 0; pixel < count; pixel++) {
          next[pixel * 4] = next[pixel * 4]! + MAX_CORNER_AA_CHANNEL_DELTA
        }
        return encodePng({ width, height, rgba: next })
      }
      const out = (f: string) => join(dir, f)

      expect(assertExactBaseline(shifted(48), baseline, 'order-dark.png', out).passes).toBe(true)
      expect(() => assertExactBaseline(shifted(49), baseline, 'order-dark.png', out)).toThrow(
        /49 pixel\(s\) differ .*bound is <= 48 pixel/
      )
      // Its sibling in black, drawn the same way, is not excused: no second drawing was measured.
      expect(() => assertExactBaseline(shifted(25), baseline, 'order-black.png', out)).toThrow(
        /25 pixel\(s\) differ .*bound is <= 24 pixel/
      )
      // A colour shift is refused on order-dark too, whatever the count.
      const loud = new Uint8Array(baseRgba)
      loud[0] = loud[0]! + MAX_CORNER_AA_CHANNEL_DELTA + 1
      expect(() =>
        assertExactBaseline(
          encodePng({ width, height, rgba: loud }),
          baseline,
          'order-dark.png',
          out
        )
      ).toThrow(/1 pixel\(s\) with channel delta > 2/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('decodes every committed visual baseline PNG in tests/visual/__screenshots__', () => {
    const pngFiles = readdirSync(BASELINE_DIR).filter((name) => name.endsWith('.png'))
    expect(pngFiles.length).toBeGreaterThanOrEqual(40)
    for (const file of pngFiles) {
      const decoded = decodePng(readFileSync(join(BASELINE_DIR, file)))
      expect(decoded.width).toBeGreaterThan(0)
      expect(decoded.height).toBeGreaterThan(0)
      expect(decoded.rgba.length).toBe(decoded.width * decoded.height * 4)
    }
  })
})
