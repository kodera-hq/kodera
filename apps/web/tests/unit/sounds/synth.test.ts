import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACOUSTIC_PACK_IDS,
  CANONICAL_CUES,
  CANONICAL_CUE_SLUGS,
  COBALT_PARTIAL_RATIO,
  HEXACHORD_PITCHES,
  TRIGGER_BINDINGS,
  clearSynthCache,
  getSynthCacheSize,
  measurePeak,
  measureRms,
  synthesizeCue,
  synthesizeCuePcm,
  waveformSignature,
} from '../../../src/features/sounds'

describe('Sonic Identity DSP Synthesizer (synth.ts)', () => {
  beforeEach(() => {
    clearSynthCache()
  })

  it('defines the 0-sharp 0-flat hexachordal spine (F -> C -> G -> D -> A -> E) and 4x Cobalt ratio', () => {
    expect(COBALT_PARTIAL_RATIO).toBe(4.0)
    expect(HEXACHORD_PITCHES).toEqual({
      G3: 196.0,
      C4: 261.63,
      D4: 293.66,
      E4: 329.63,
      F4: 349.23,
      G4: 392.0,
      A4: 440.0,
      C5: 523.25,
      D5: 587.33,
      E5: 659.26,
      A5: 880.0,
    })

    // Exactly 31 canonical cues per pack (26 semantic triggers + 5 mention/VIP variants)
    expect(CANONICAL_CUES).toHaveLength(31)
    expect(CANONICAL_CUE_SLUGS).toHaveLength(31)
    expect(CANONICAL_CUES.filter((c) => c.semantic !== null)).toHaveLength(26)
  })

  it('synthesizes deterministic, non-zero, unclipped Float32Array PCM across all 5 packs and 31 canonical cues (155 masters)', () => {
    for (const pack of ACOUSTIC_PACK_IDS) {
      for (const slug of CANONICAL_CUE_SLUGS) {
        const res = synthesizeCue(pack, slug)
        const pcm = res.mono

        expect(pcm).toBeInstanceOf(Float32Array)
        expect(pcm.length).toBeGreaterThan(2048)

        let hasNaN = false
        for (let i = 0; i < pcm.length; i++) {
          const s = pcm[i] ?? 0
          if (Number.isNaN(s) || !Number.isFinite(s)) {
            hasNaN = true
            break
          }
        }
        expect(hasNaN, `${pack}/${slug} contains NaN or Infinity`).toBe(false)

        const peak = measurePeak(pcm)
        const rms = measureRms(pcm)
        expect(peak, `${pack}/${slug} should be non-zero`).toBeGreaterThan(0.01)
        expect(peak, `${pack}/${slug} should never clip above 1.0`).toBeLessThanOrEqual(1.0)
        expect(rms, `${pack}/${slug} RMS should be positive`).toBeGreaterThan(0.001)

        // Start and end frames are zeroed to prevent boundary clicks
        expect(pcm[0]).toBe(0)
        expect(pcm[pcm.length - 1]).toBe(0)

        // Souffle enforces whisper ceiling (<= -9.8 dBTP) across all Tier 1..3 cues
        const cueMeta = CANONICAL_CUES.find((c) => c.slug === slug)!
        if (pack === 'souffle' && cueMeta.tier !== 0) {
          expect(res.truePeakDb, `souffle/${slug} whisper ceiling`).toBeLessThanOrEqual(-9.8)
        }
      }
    }

    expect(getSynthCacheSize()).toBe(155)
  }, 60_000)

  it('caches lazily per (pack, cue) and produces identical deterministic output across runs', () => {
    expect(getSynthCacheSize()).toBe(0)
    const first = synthesizeCuePcm('givre', 'voice_self_join')
    expect(getSynthCacheSize()).toBe(1)

    const cached = synthesizeCuePcm('givre', 'room-self-join')
    expect(cached).toBe(first)

    const sig1 = waveformSignature(first)
    clearSynthCache()
    expect(getSynthCacheSize()).toBe(0)

    const second = synthesizeCuePcm('givre', 'voice_self_join')
    const sig2 = waveformSignature(second)
    expect(sig2).toBe(sig1)
    expect(Array.from(second.slice(0, 256))).toEqual(Array.from(first.slice(0, 256)))
  })

  it('produces distinct waveform signatures across all 5 packs for the same semantic trigger', () => {
    const triggersToCompare = [
      'voice_self_join',
      'voice_mute_on',
      'msg_mention',
      'call_ring_incoming_loop',
      'voice_guest_knock',
    ] as const

    for (const trigger of triggersToCompare) {
      const signatures = new Set<string>()
      for (const pack of ACOUSTIC_PACK_IDS) {
        const pcm = synthesizeCuePcm(pack, trigger)
        signatures.add(waveformSignature(pcm))
      }
      expect(signatures.size, `all 5 packs must differ for ${trigger}`).toBe(5)
    }
  })

  it('synthesizes every semantic trigger binding including ptt_engage, ptt_release, call_connect, and call_end', () => {
    const triggerIds = Object.keys(TRIGGER_BINDINGS)
    expect(triggerIds.length).toBeGreaterThanOrEqual(26)

    const signatures = new Set<string>()
    for (const triggerId of triggerIds) {
      const pcm = synthesizeCuePcm('givre', triggerId)
      expect(measurePeak(pcm), `${triggerId} peak`).toBeGreaterThan(0.01)
      expect(measurePeak(pcm), `${triggerId} ceiling`).toBeLessThanOrEqual(1.0)
      signatures.add(`${triggerId}:${waveformSignature(pcm)}`)
    }
    expect(signatures.size).toBe(triggerIds.length)
  })

  it('returns silent zeroed Float32Array for silencieux unless Tier 0 safety fallback is requested', () => {
    const silentJoin = synthesizeCuePcm('silencieux', 'voice_self_join')
    expect(measurePeak(silentJoin)).toBe(0)

    const safetyRecStart = synthesizeCue('silencieux', 'compliance_rec_start', {
      allowSilencieuxSafetyFallback: true,
    })
    expect(safetyRecStart.effectivePack).toBe('souffle')
    expect(measurePeak(safetyRecStart.mono)).toBeGreaterThan(0.02)
  })

  it('ensures SoundsScreen.tsx uses only @kodera/design-tokens classes with zero inline style={{}}, zero raw hex, and zero *-c-action edge/text classes', () => {
    const sourcePath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'src',
      'features',
      'sounds',
      'SoundsScreen.tsx'
    )
    const source = readFileSync(sourcePath, 'utf8')

    expect(source).not.toMatch(/style=\{\{/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(source).not.toMatch(/(?:text|border|ring|accent)-c-action/)
  })
})
