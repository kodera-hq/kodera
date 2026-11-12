// The proximity frame codec, held to the vectors every platform reads.
//
// `packages/kodera-rs/vectors/proximity-frame-v1.txt` holds the frozen wire bytes of frame v1:
// its constants, frames that decode to stated fields and encode back to the same bytes, the
// transcript each one signs, and frames that must be refused. Rust, Swift and Kotlin agree with
// every line; this test holds the TypeScript codec (`src/features/proximity/codec.ts`) to the
// same file, entry for entry.
//
// The file arrives with the native change. Until this checkout holds it the whole suite is
// skipped, by name, and it runs by itself from the day the file is there: nothing to switch on.
// A line this test cannot read is an error, not a line to step over, so the file cannot grow a
// kind of entry the web codec is silently not held to.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProximityFrame, bytesToHex, hexToBytes } from '@/features/proximity/codec'
import {
  MAX_PROXIMITY_FRAME_BYTES,
  MAX_PROXIMITY_TEXT_BYTES,
  MAX_PROXIMITY_TTL_HOPS,
  PROXIMITY_FIXED_OVERHEAD_BYTES,
  PROXIMITY_PROTOCOL_VERSION,
} from '@/features/proximity/types'

/** The file the Rust, Swift and Kotlin implementations read, when this checkout holds it. */
const SOURCE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages/kodera-rs/vectors/proximity-frame-v1.txt'
)
const PRESENT = existsSync(SOURCE)

interface FrameEntry {
  readonly name: string
  readonly ttlHops: number
  readonly status: number
  readonly timestampMs: number
  readonly textHex: string
  readonly wireHex: string
  readonly transcriptHex: string
}

interface Vectors {
  readonly constants: ReadonlyMap<string, string>
  readonly frames: readonly FrameEntry[]
  readonly refusals: readonly { readonly name: string; readonly wireHex: string }[]
}

function parse(text: string): Vectors {
  const constants = new Map<string, string>()
  const frames: FrameEntry[] = []
  const refusals: { name: string; wireHex: string }[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const fields = line.split(' ')
    const [kind, name] = fields
    if (kind === 'const' && fields.length === 3 && name !== undefined) {
      if (constants.has(name)) throw new Error(`line ${index + 1}: const ${name} is given twice`)
      constants.set(name, fields[2]!)
    } else if (kind === 'frame' && fields.length === 8 && name !== undefined) {
      frames.push({
        name,
        ttlHops: Number(fields[2]),
        status: Number(fields[3]),
        timestampMs: Number(fields[4]),
        textHex: fields[5] === '-' ? '' : fields[5]!,
        wireHex: fields[6]!,
        transcriptHex: fields[7]!,
      })
    } else if (kind === 'refuse' && fields.length === 3 && name !== undefined) {
      refusals.push({ name, wireHex: fields[2]! })
    } else {
      throw new Error(`line ${index + 1} is no entry this test knows: ${line.slice(0, 60)}`)
    }
  }
  return { constants, frames, refusals }
}

/** The transcript a decoded frame signs: the label, the id, the sender, the status, the text. */
function transcriptOf(frame: ProximityFrame): Uint8Array {
  return ProximityFrame.signingTranscript(
    frame.messageId,
    frame.senderPublicKey,
    frame.status,
    new TextEncoder().encode(frame.text)
  )
}

describe.skipIf(!PRESENT)(
  'proximity frame v1 vectors (packages/kodera-rs/vectors/proximity-frame-v1.txt; skipped while that file is not in this checkout)',
  () => {
    const vectors = PRESENT ? parse(readFileSync(SOURCE, 'utf8')) : parse('')

    it('holds enough entries to mean something', () => {
      expect(vectors.frames.length).toBeGreaterThanOrEqual(5)
      expect(vectors.refusals.length).toBeGreaterThanOrEqual(10)
    })

    it('agrees with every constant, and knows every constant the file gives', () => {
      const canonical = ProximityFrame.decode(hexToBytes(vectors.frames[0]!.wireHex))
      const mine: Readonly<Record<string, string>> = {
        magic_hex: bytesToHex(ProximityFrame.MAGIC),
        version: String(PROXIMITY_PROTOCOL_VERSION),
        fixed_overhead_bytes: String(PROXIMITY_FIXED_OVERHEAD_BYTES),
        max_frame_bytes: String(MAX_PROXIMITY_FRAME_BYTES),
        max_text_bytes: String(MAX_PROXIMITY_TEXT_BYTES),
        max_ttl_hops: String(MAX_PROXIMITY_TTL_HOPS),
        // The signed label is historical wire data: read back from a transcript, never restated.
        signing_label_hex: bytesToHex(transcriptOf(canonical).subarray(0, 20)),
      }
      expect(Object.fromEntries(vectors.constants)).toEqual(mine)
    })

    it('decodes every frame to its stated fields', () => {
      for (const entry of vectors.frames) {
        const frame = ProximityFrame.decode(hexToBytes(entry.wireHex))
        expect(
          {
            ttlHops: frame.ttlHops,
            status: frame.status as number,
            timestampMs: frame.messageId.timestampMs(),
            textHex: bytesToHex(new TextEncoder().encode(frame.text)),
          },
          entry.name
        ).toEqual({
          ttlHops: entry.ttlHops,
          status: entry.status,
          timestampMs: entry.timestampMs,
          textHex: entry.textHex,
        })
      }
    })

    it('encodes every frame back to exactly its wire bytes', () => {
      for (const entry of vectors.frames)
        expect(
          bytesToHex(ProximityFrame.decode(hexToBytes(entry.wireHex)).encode()),
          entry.name
        ).toBe(entry.wireHex)
    })

    it('signs exactly the stated transcript, which leaves the hop count out', () => {
      for (const entry of vectors.frames) {
        const frame = ProximityFrame.decode(hexToBytes(entry.wireHex))
        expect(bytesToHex(transcriptOf(frame)), entry.name).toBe(entry.transcriptHex)
        const relayed = frame.decrementHop()
        if (relayed !== null)
          expect(bytesToHex(transcriptOf(relayed)), `${entry.name}, relayed`).toBe(
            entry.transcriptHex
          )
      }
    })

    it('refuses every frame the file says must be refused', () => {
      for (const entry of vectors.refusals)
        expect(() => ProximityFrame.decode(hexToBytes(entry.wireHex)), entry.name).toThrow()
    })
  }
)

describe('reading the vector file', () => {
  it('reads the three kinds of entry and nothing else', () => {
    const read = parse(
      [
        '# a comment',
        '',
        'const version 1',
        'frame a 3 1 1762520100000 - 4b45 6b6f',
        'refuse b 4a45',
      ].join('\n')
    )
    expect(Object.fromEntries(read.constants)).toEqual({ version: '1' })
    expect(read.frames).toEqual([
      {
        name: 'a',
        ttlHops: 3,
        status: 1,
        timestampMs: 1762520100000,
        textHex: '',
        wireHex: '4b45',
        transcriptHex: '6b6f',
      },
    ])
    expect(read.refusals).toEqual([{ name: 'b', wireHex: '4a45' }])
  })

  it.each([
    ['an unknown kind', 'vector a 4b45'],
    ['a frame with a field missing', 'frame a 3 1 1762520100000 - 4b45'],
    ['a constant given twice', 'const version 1\nconst version 2'],
    ['a refusal with a field too many', 'refuse a 4b45 extra'],
  ])('refuses %s rather than stepping over it', (_, text) => {
    expect(() => parse(text)).toThrow()
  })
})
