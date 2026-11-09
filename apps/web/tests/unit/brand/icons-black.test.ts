import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

// The icons, the manifest and the address bar share the validated dark brand: the white
// monogram on #000000. Every raster is full-bleed and opaque, so its corner pixel is the black
// ground itself; scripts/render-icons.py writes them from public/favicon.svg.

const ROOT = join(import.meta.dirname, '..', '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path))
const BLACK = [0, 0, 0, 255]

interface Raster {
  readonly width: number
  readonly height: number
  /** RGBA at (x, y); an RGB image reads as opaque. */
  pixel(x: number, y: number): number[]
  /** The red channel at (x, y), without building an array. */
  red(x: number, y: number): number
}

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG: the only kind the generator writes. */
function decodePng(png: Buffer): Raster {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect(data[8], 'bit depth').toBe(8)
      expect([2, 6], 'colour type').toContain(data[9])
      expect(data[12], 'interlace').toBe(0)
      channels = data[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!
    // One check per row: an expect per byte would cost seconds on the 512 px icons.
    if (filter > 4) expect.unreachable(`row ${y}: filter type ${filter}`)
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i]!
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels]! : 0
      let predicted = 0
      if (filter === 1) predicted = a
      else if (filter === 2) predicted = b
      else if (filter === 3) predicted = Math.floor((a + b) / 2)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[y * stride + i] = (x + predicted) & 0xff
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const start = y * stride + x * channels
      const rgb = [...pixels.subarray(start, start + 3)]
      return [...rgb, channels === 4 ? pixels[start + 3]! : 255]
    },
    red(x, y) {
      return pixels[y * stride + x * channels]!
    },
  }
}

/** The frames of an .ico, each of which must be a PNG. */
function icoFrames(ico: Buffer): { size: number; raster: Raster }[] {
  expect(ico.readUInt16LE(0), 'reserved').toBe(0)
  expect(ico.readUInt16LE(2), 'type: icon').toBe(1)
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + 16 * index
    const size = ico[entry] === 0 ? 256 : ico[entry]!
    const bytes = ico.readUInt32LE(entry + 8)
    const start = ico.readUInt32LE(entry + 12)
    return { size, raster: decodePng(ico.subarray(start, start + bytes)) }
  })
}

function corners(raster: Raster): number[][] {
  const { width: w, height: h } = raster
  return [
    raster.pixel(0, 0),
    raster.pixel(w - 1, 0),
    raster.pixel(0, h - 1),
    raster.pixel(w - 1, h - 1),
  ]
}

/** The share of pixels whose red channel is at least `level`: the white mark, anti-aliased. */
function lit(raster: Raster, level = 128): number {
  let count = 0
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (raster.red(x, y) >= level) count += 1
    }
  }
  return count / (raster.width * raster.height)
}

const PNGS: [string, number][] = [
  ['public/icon-16.png', 16],
  ['public/icon-32.png', 32],
  ['public/icon-48.png', 48],
  ['public/icon-180.png', 180],
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['public/icon-512-maskable.png', 512],
]

describe('the icons are the white monogram on #000000', () => {
  it.each(PNGS)('%s: its size, four black opaque corners, and the mark on it', (file, size) => {
    const raster = decodePng(read(file))
    expect([raster.width, raster.height]).toEqual([size, size])
    expect(corners(raster)).toEqual([BLACK, BLACK, BLACK, BLACK])
    // The mark covers roughly a fifth of the tile; neither an empty nor a white tile passes.
    expect(lit(raster)).toBeGreaterThan(0.1)
    expect(lit(raster)).toBeLessThan(0.35)
  })

  it('favicon.ico holds the 16, 32 and 48 frames, each black at its corners', () => {
    const frames = icoFrames(read('public/favicon.ico'))
    expect(frames.map((frame) => frame.size).sort((a, b) => a - b)).toEqual([16, 32, 48])
    for (const { size, raster } of frames) {
      expect([raster.width, raster.height], `frame ${size}`).toEqual([size, size])
      expect(corners(raster), `frame ${size}`).toEqual([BLACK, BLACK, BLACK, BLACK])
      expect(lit(raster), `frame ${size}`).toBeGreaterThan(0.1)
    }
  })

  it('the maskable icon keeps every lit pixel inside the central 80 % safe zone', () => {
    const raster = decodePng(read('public/icon-512-maskable.png'))
    const radius = 0.4 * raster.width
    const centre = raster.width / 2
    const outside: string[] = []
    let checked = 0
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        if (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) <= radius) continue
        checked += 1
        if (raster.pixel(x, y).join() !== BLACK.join()) outside.push(`(${x}, ${y})`)
      }
    }
    // About half the tile lies outside the circle; a zero here would make the check vacuous.
    expect(checked).toBeGreaterThan(0.45 * raster.width * raster.height)
    expect(outside.slice(0, 10)).toEqual([])
  })

  it('the manifest and the address bar use the same black', () => {
    const manifest = JSON.parse(read('public/site.webmanifest').toString('utf8')) as Record<
      string,
      unknown
    >
    expect(manifest.theme_color).toBe('#000000')
    expect(manifest.background_color).toBe('#000000')
    const html = read('index.html').toString('utf8')
    const themeColors = [...html.matchAll(/<meta name="theme-color" content="([^"]*)"/g)].map(
      (match) => match[1]
    )
    expect(themeColors).toEqual(['#000000'])
    expect(read('public/favicon.svg').toString('utf8')).toMatch(
      /<rect width="512" height="512"[^>]*fill="#000000"/
    )
  })
})
