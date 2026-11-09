// Playwright compares screenshots with pixelmatch and does not let a caller turn off its
// anti-aliasing detection (`includeAA` is fixed to false): a differing pixel that looks like an
// anti-aliased edge is skipped, whatever `threshold` says. A 1 px border sits between two
// contrasting colours, so it looks like one. A wrong border colour therefore passed at
// `threshold: 0`: `home-light.png` still held the secondary button's edge in `border-strong`
// (#C9D3DE) after #207 moved it to `border-input` (#7C8894), and passed.
//
// This check closes that gap. After `toHaveScreenshot` passes, the same capture is compared to
// the baseline decoded, every channel of every pixel. Every pixel must be byte-identical
// (`maxChannelDelta === 0`), except at most `MAX_CORNER_AA_PIXELS = 24` pixels across the image
// may differ by at most `MAX_CORNER_AA_CHANNEL_DELTA = 2` (`Math.max(|dR|, |dG|, |dB|, |dA|) <= 2`)
// to cover the measured 1-in-16 Chromium button-corner raster variance (`order` 16 px, `invoices`
// 24 px, `invoice-detail-1024`) without ever excusing a token or border colour shift (such as
// `#C9D3DE` vs `#7C8894`, where `|dR| = 77`).
//
// One screen has a count of its own. Chromium draws `order-dark` in one of two ways, in about half
// of CI's runs and on every CPU model seen: the second differs at 41 corner pixels (38 at delta 1,
// 3 at delta 2), byte-identical from run to run, and never appears in the same image emulated on
// Apple silicon. A new baseline would only swap which drawing fails, so that screen alone is
// allowed 48 pixels, still at delta 2 or less; every other screen keeps 24.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { expect, type Page, type TestInfo } from '@playwright/test'

export const BASELINE_DIR = join(import.meta.dirname, '..', '__screenshots__')

/** Maximum number of corner anti-aliasing pixels allowed to differ by at most 2 channel units. */
export const MAX_CORNER_AA_PIXELS = 24

/** The screens Chromium draws two ways, each with the corner count its second drawing needs. */
export const CORNER_AA_PIXELS_BY_BASELINE: Readonly<Record<string, number>> = {
  'order-dark.png': 48,
}

/** How many corner anti-aliasing pixels a baseline allows. */
export function cornerAaPixels(name: string): number {
  return CORNER_AA_PIXELS_BY_BASELINE[name] ?? MAX_CORNER_AA_PIXELS
}

/** Maximum per-channel delta (`Math.max(|dR|, |dG|, |dB|, |dA|)`) for a corner-AA pixel. */
export const MAX_CORNER_AA_CHANNEL_DELTA = 2

export interface Decoded {
  width: number
  height: number
  /** RGBA, 8 bits per channel, row after row. */
  rgba: Uint8Array
}

export interface BaselineComparison {
  readonly sameSize: boolean
  readonly differingPixels: number
  readonly loudPixels: number
  readonly maxChannelDelta: number
  readonly passes: boolean
}

const SIGNATURE = '89504e470d0a1a0a'

/** A PNG as Playwright and Chromium write it: 8-bit RGB or RGBA, not interlaced. */
export function decodePng(bytes: Buffer): Decoded {
  if (bytes.subarray(0, 8).toString('hex') !== SIGNATURE) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let channels = 0
  let seenIhdr = false
  let seenIend = false
  const data: Buffer[] = []
  for (let at = 8; at < bytes.length;) {
    if (at + 12 > bytes.length) throw new Error('truncated PNG chunk')
    const length = bytes.readUInt32BE(at)
    if (at + 12 + length > bytes.length) throw new Error('truncated PNG chunk')
    const type = bytes.toString('latin1', at + 4, at + 8)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      if (body.length !== 13) throw new Error(`invalid IHDR length ${body.length}`)
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const [depth, colour, compression, filterMethod, interlace] = [
        body[8],
        body[9],
        body[10],
        body[11],
        body[12],
      ]
      if (
        width === 0 ||
        height === 0 ||
        depth !== 8 ||
        compression !== 0 ||
        filterMethod !== 0 ||
        interlace !== 0 ||
        (colour !== 2 && colour !== 6)
      ) {
        throw new Error(
          `unsupported PNG: ${width}x${height}, depth ${depth}, colour type ${colour}, compression ${compression}, filter ${filterMethod}, interlace ${interlace}`
        )
      }
      channels = colour === 6 ? 4 : 3
      seenIhdr = true
    } else if (type === 'tRNS') {
      throw new Error('unsupported PNG: tRNS chunk')
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') {
      seenIend = true
      break
    }
    at += 12 + length
  }
  if (!seenIhdr || !seenIend || data.length === 0) {
    throw new Error('incomplete PNG: missing IHDR, IDAT, or IEND')
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const expectedRawLength = (stride + 1) * height
  if (raw.length !== expectedRawLength) {
    throw new Error(`unexpected inflated PNG length ${raw.length}, expected ${expectedRawLength}`)
  }
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`)
      pixels[y * stride + x] = (line[x]! + predictor) & 0xff
    }
  }
  if (channels === 4) return { width, height, rgba: pixels }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i]!
    rgba[j + 1] = pixels[i + 1]!
    rgba[j + 2] = pixels[i + 2]!
    rgba[j + 3] = 255
  }
  return { width, height, rgba }
}

function pngChunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length, 0)
  header.write(type, 4, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4, 8), body])) >>> 0, 0)
  return Buffer.concat([header, body, crc])
}

/** Encodes an 8-bit RGBA buffer into a valid non-interlaced PNG. */
export function encodePng(decoded: Decoded): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(decoded.width, 0)
  ihdr.writeUInt32BE(decoded.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = decoded.width * 4
  const raw = Buffer.alloc((stride + 1) * decoded.height)
  for (let y = 0; y < decoded.height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(decoded.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from(SIGNATURE, 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Compares every RGBA pixel of `actual` and `baseline`.
 * Enforces zero dimension mismatch, zero pixels with channel delta > 2, and at most `maxPixels`
 * pixels (24 unless the baseline has its own count) with channel delta in 1..2.
 */
export function compareDecoded(
  actual: Decoded,
  baseline: Decoded,
  maxPixels: number = MAX_CORNER_AA_PIXELS
): BaselineComparison {
  if (
    actual.width !== baseline.width ||
    actual.height !== baseline.height ||
    actual.rgba.length !== baseline.rgba.length
  ) {
    return {
      sameSize: false,
      differingPixels: -1,
      loudPixels: -1,
      maxChannelDelta: -1,
      passes: false,
    }
  }
  let differingPixels = 0
  let loudPixels = 0
  let maxChannelDelta = 0
  for (let i = 0; i < actual.rgba.length; i += 4) {
    const dR = Math.abs(actual.rgba[i]! - baseline.rgba[i]!)
    const dG = Math.abs(actual.rgba[i + 1]! - baseline.rgba[i + 1]!)
    const dB = Math.abs(actual.rgba[i + 2]! - baseline.rgba[i + 2]!)
    const dA = Math.abs(actual.rgba[i + 3]! - baseline.rgba[i + 3]!)
    const delta = Math.max(dR, dG, dB, dA)
    if (delta > 0) {
      differingPixels++
      if (delta > maxChannelDelta) maxChannelDelta = delta
      if (delta > MAX_CORNER_AA_CHANNEL_DELTA) loudPixels++
    }
  }
  return {
    sameSize: true,
    differingPixels,
    loudPixels,
    maxChannelDelta,
    passes: loudPixels === 0 && differingPixels <= maxPixels,
  }
}

/** How many pixels differ in any channel; -1 when the sizes differ. */
export function differingPixels(a: Decoded, b: Decoded): number {
  return compareDecoded(a, b).differingPixels
}

/**
 * Decodes and compares `actual` against `baseline` under the bounded corner-AA rule.
 * On failure, writes `<name>-exact-actual.png` via `outputPath` before throwing the assertion.
 */
export function assertExactBaseline(
  actual: Buffer,
  baseline: Buffer,
  name: string,
  outputPath: (fileName: string) => string
): BaselineComparison {
  const bound = cornerAaPixels(name)
  const result = compareDecoded(decodePng(actual), decodePng(baseline), bound)
  if (!result.passes) {
    writeFileSync(outputPath(name.replace(/\.png$/, '-exact-actual.png')), actual)
  }
  const detail = !result.sameSize
    ? 'a different size'
    : `${result.differingPixels} pixel(s) differ (max channel delta ${result.maxChannelDelta}, ${result.loudPixels} pixel(s) with channel delta > ${MAX_CORNER_AA_CHANNEL_DELTA}; bound is <= ${bound} pixel(s) at delta <= ${MAX_CORNER_AA_CHANNEL_DELTA})`
  expect(
    result.passes,
    `${name}: ${detail}, counting the anti-aliased ones toHaveScreenshot skips`
  ).toBe(true)
  return result
}

/** The capture `toHaveScreenshot` takes by default, so both checks judge the same pixels. */
export function capture(page: Page): Promise<Buffer> {
  return page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' })
}

/**
 * `toHaveScreenshot`, then the exact RGBA comparison with the bounded 2-unit / 24-pixel corner-AA
 * tolerance. On a refusal the capture is written to the test's output folder as
 * `<name>-exact-actual.png`, which CI uploads with the other diffs.
 */
export async function matchBaseline(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  await expect(page).toHaveScreenshot(name, { maxDiffPixels: cornerAaPixels(name) })
  const updating =
    testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed'
  if (updating) return
  const actual = await capture(page)
  const baseline = readFileSync(join(BASELINE_DIR, name))
  assertExactBaseline(actual, baseline, name, (fileName) => testInfo.outputPath(fileName))
}
