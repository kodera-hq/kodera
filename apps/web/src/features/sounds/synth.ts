import {
  ACOUSTIC_PACK_IDS,
  COBALT_PARTIAL_RATIO,
  HEXACHORD_PITCHES,
  PACK_PROFILES,
  SILENCIEUX_SAFETY_PACK,
  getCueSpecBySlug,
  resolveSoundTrigger,
} from './manifest'
import type {
  AcousticPackId,
  CueSynthSpec,
  MentionVariantId,
  SoundPackId,
  SoundTier,
  SoundTriggerInput,
} from './types'

export const SYNTH_SAMPLE_RATE = 48000

const SR = SYNTH_SAMPLE_RATE
const TWO_PI = Math.PI * 2
const MASK64 = 0xffffffffffffffffn
const P = HEXACHORD_PITCHES

export interface ScoreNoteEvent {
  f0: number
  onset: number
  dur: number
  atk: number
  gain: number
  pan: number
  cobaltHz: number | null
  cobaltTrim?: number
  damper?: boolean
  woodTap?: boolean
  isHarmony?: boolean
  tier?: SoundTier
}

export interface SynthesizedCueResult {
  readonly pack: SoundPackId
  readonly effectivePack: AcousticPackId | null
  readonly slug: string
  readonly sampleRate: number
  readonly mono: Float32Array
  readonly left: Float32Array
  readonly right: Float32Array
  readonly durationMs: number
  readonly activeMs: number
  readonly lufs: number
  readonly truePeakDb: number
  readonly peakLinear: number
  readonly stereoCorrelation: number
  readonly cobaltHz: number | null
}

const synthCache = new Map<string, SynthesizedCueResult>()

export function clearSynthCache(): void {
  synthCache.clear()
}

export function getSynthCacheSize(): number {
  return synthCache.size
}

export function splitMix64(seed: string): () => number {
  let s = 0xcbf29ce484222325n
  for (let i = 0; i < seed.length; i++) {
    s = ((s ^ BigInt(seed.charCodeAt(i))) * 0x100000001b3n) & MASK64
  }
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK64
    let z = ((s ^ (s >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64
    return Number(((z ^ (z >> 31n)) & MASK64) >> 11n) / 9007199254740992
  }
}

const rcIn = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 * (1 - Math.cos(Math.PI * u)))
const rcOut = (u: number): number => (u <= 0 ? 1 : u >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * u)))

export function bezier(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 5; i++) {
    const u = 1 - t
    const bx = 3 * u * u * t * 0.2 + 3 * u * t * t * 0.3 + t * t * t - x
    const dx = 3 * u * u * 0.2 + 6 * u * t * 0.1 + 3 * t * t * 0.7
    if (Math.abs(dx) < 1e-6) break
    t = Math.min(1, Math.max(0, t - bx / dx))
  }
  const u = 1 - t
  return 3 * u * u * t * 0.7 + 3 * u * t * t + t * t * t
}

interface StateVariableFilter {
  set(nfc: number, nQ?: number): void
  step(x: number): { lp: number; bp: number; hp: number }
}

function createSVF(fc: number, Q: number): StateVariableFilter {
  let ic1 = 0
  let ic2 = 0
  let g = Math.tan((Math.PI * Math.min(Math.max(25, fc), SR * 0.44)) / SR)
  let k = 1 / Q
  return {
    set(nfc: number, nQ = Q) {
      g = Math.tan((Math.PI * Math.min(Math.max(25, nfc), SR * 0.44)) / SR)
      k = 1 / nQ
    },
    step(x: number) {
      const a1 = 1 / (1 + g * (g + k))
      const a2 = g * a1
      const a3 = g * a2
      const v3 = x - ic2
      const v1 = a1 * ic1 + a2 * v3
      const v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      return { lp: v2, bp: v1, hp: x - k * v1 - v2 }
    },
  }
}

function makeBiquad(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number
): (x: number) => number {
  const nb0 = b0 / a0
  const nb1 = b1 / a0
  const nb2 = b2 / a0
  const na1 = a1 / a0
  const na2 = a2 / a0
  let z1 = 0
  let z2 = 0
  return (x: number) => {
    const y = nb0 * x + z1
    z1 = nb1 * x - na1 * y + z2
    z2 = nb2 * x - na2 * y
    return y
  }
}

function makeHighpass(fc: number, Q = Math.SQRT1_2): (x: number) => number {
  const w0 = (TWO_PI * fc) / SR
  const c = Math.cos(w0)
  const al = Math.sin(w0) / (2 * Q)
  return makeBiquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al)
}

function makeLowpass(fc: number, Q = Math.SQRT1_2): (x: number) => number {
  const w0 = (TWO_PI * fc) / SR
  const c = Math.cos(w0)
  const al = Math.sin(w0) / (2 * Q)
  return makeBiquad((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al)
}

function makePeaking(fc: number, Q: number, gainDb: number): (x: number) => number {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (TWO_PI * fc) / SR
  const c = Math.cos(w0)
  const al = Math.sin(w0) / (2 * Q)
  return makeBiquad(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A)
}

export function measureBS1770LUFS(cL: Float64Array | Float32Array, cR: Float64Array | Float32Array): number {
  const preL = makeBiquad(
    1.53512485958697,
    -2.69169618940638,
    1.19839281085285,
    1.0,
    -1.69065929318241,
    0.73248077421585
  )
  const preR = makeBiquad(
    1.53512485958697,
    -2.69169618940638,
    1.19839281085285,
    1.0,
    -1.69065929318241,
    0.73248077421585
  )
  const rlbL = makeBiquad(1.0, -2.0, 1.0, 1.0, -1.99004745483398, 0.99007225036621)
  const rlbR = makeBiquad(1.0, -2.0, 1.0, 1.0, -1.99004745483398, 0.99007225036621)
  let sumSq = 0
  let activeCnt = 0
  for (let i = 0; i < cL.length; i++) {
    const sL = cL[i] ?? 0
    const sR = cR[i] ?? 0
    const yL = rlbL(preL(sL))
    const yR = rlbR(preR(sR))
    if (Math.max(Math.abs(sL), Math.abs(sR)) > 0.0018) {
      sumSq += yL * yL + yR * yR
      activeCnt++
    }
  }
  return -0.691 + 10 * Math.log10(Math.max(1e-12, sumSq / Math.max(960, activeCnt)))
}

export function hermitePeak4x(arr: Float64Array | Float32Array): number {
  let maxAbs = 0
  const n = arr.length
  for (let i = 0; i < n; i++) {
    const a = Math.abs(arr[i] ?? 0)
    if (a > maxAbs) maxAbs = a
  }
  for (let i = 1; i < n - 2; i++) {
    const y0 = arr[i - 1] ?? 0
    const y1 = arr[i] ?? 0
    const y2 = arr[i + 1] ?? 0
    const y3 = arr[i + 2] ?? 0
    const c0 = y1
    const c1 = 0.5 * (y2 - y0)
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
    for (let k = 1; k <= 3; k++) {
      const t = k * 0.25
      const v = Math.abs(((c3 * t + c2) * t + c1) * t + c0)
      if (v > maxAbs) maxAbs = v
    }
  }
  return maxAbs
}

function velvetGen(rng: () => number, density = 2600): (i: number) => number {
  const step = Math.max(8, Math.round(SR / density))
  const norm = Math.sqrt(SR / density)
  let grid = -step
  let at = -1
  let sgn = 1
  return (i: number) => {
    if (i >= grid + step) {
      grid += step
      at = grid + Math.floor(rng() * (step - 1))
      sgn = rng() < 0.5 ? norm : -norm
    }
    return i === at ? sgn : 0
  }
}

export function resolveScore(cue: CueSynthSpec, pack: AcousticPackId): ScoreNoteEvent[] {
  let list: ScoreNoteEvent[]
  if (cue.stereoTest) {
    list = [
      { f0: P.D4, onset: 0.0, dur: 0.24, atk: 0.006, gain: 0.92, pan: -0.88, cobaltHz: null, tier: 0 },
      {
        f0: P.A4,
        onset: 0.3,
        dur: 0.24,
        atk: 0.006,
        gain: 0.92,
        pan: 0.88,
        cobaltHz: P.A4 * COBALT_PARTIAL_RATIO,
        cobaltTrim: 0.55,
        tier: 0,
      },
      { f0: P.D4, onset: 0.6, dur: 0.32, atk: 0.007, gain: 0.72, pan: 0, cobaltHz: null, tier: 0 },
      {
        f0: P.A4,
        onset: 0.6,
        dur: 0.32,
        atk: 0.007,
        gain: 0.78,
        pan: 0,
        cobaltHz: null,
        isHarmony: true,
        tier: 0,
      },
      {
        f0: P.D5,
        onset: 0.6,
        dur: 0.34,
        atk: 0.007,
        gain: 0.88,
        pan: 0,
        cobaltHz: P.D5 * COBALT_PARTIAL_RATIO,
        cobaltTrim: 1.0,
        isHarmony: true,
        tier: 0,
      },
    ]
  } else if (cue.isMention) {
    const cobMul = cue.vip ? 1.28 : 1.0
    if (cue.variant === 'goutte') {
      list = cue.vip
        ? [
            { f0: P.A4, onset: 0, dur: 0.11, atk: 0.005, gain: 0.44, pan: 0, cobaltHz: null },
            {
              f0: P.D5,
              onset: 0.045,
              dur: 0.14,
              atk: 0.0055,
              gain: 1.0,
              pan: 0,
              cobaltHz: P.D5 * COBALT_PARTIAL_RATIO,
              cobaltTrim: cobMul,
            },
          ]
        : [
            {
              f0: P.D5,
              onset: 0,
              dur: 0.13,
              atk: 0.0055,
              gain: 1.0,
              pan: 0,
              cobaltHz: P.D5 * COBALT_PARTIAL_RATIO,
              cobaltTrim: cobMul,
            },
          ]
    } else if (cue.variant === 'sillage') {
      list = [
        { f0: P.D4, onset: 0, dur: 0.24, atk: 0.006, gain: 0.78, pan: 0, cobaltHz: null },
        { f0: P.A4, onset: 0.065, dur: 0.22, atk: 0.006, gain: 0.86, pan: 0, cobaltHz: null },
        {
          f0: P.E5,
          onset: 0.13,
          dur: 0.2,
          atk: 0.006,
          gain: 1.0,
          pan: 0,
          cobaltHz: P.E5 * COBALT_PARTIAL_RATIO,
          cobaltTrim: cobMul,
        },
      ]
      if (cue.vip) {
        list.push({
          f0: P.A5,
          onset: 0.13,
          dur: 0.19,
          atk: 0.008,
          gain: 0.32,
          pan: 0,
          cobaltHz: null,
          isHarmony: true,
        })
      }
    } else {
      list = [
        { f0: P.A4, onset: 0, dur: 0.17, atk: 0.006, gain: 0.82, pan: 0, cobaltHz: null },
        {
          f0: P.E5,
          onset: 0.06,
          dur: 0.17,
          atk: 0.006,
          gain: 1.0,
          pan: 0,
          cobaltHz: P.E5 * COBALT_PARTIAL_RATIO,
          cobaltTrim: cobMul,
        },
      ]
      if (cue.vip) {
        list.push({
          f0: P.D5,
          onset: 0.06,
          dur: 0.16,
          atk: 0.006,
          gain: 0.48,
          pan: 0,
          cobaltHz: null,
          isHarmony: true,
        })
      }
    }
  } else {
    const notes = cue.notes ?? [P.D4, P.A4]
    const onsets = cue.onsets ?? [0, 0.065]
    list = notes.map((f0, idx) => {
      const isLast = idx === notes.length - 1
      const isRingPeak = cue.slug === 'call-ringtone-in' && (idx === 2 || idx === 3)
      const cob = isRingPeak
        ? idx === 2
          ? P.E5 * COBALT_PARTIAL_RATIO
          : P.D5 * COBALT_PARTIAL_RATIO
        : isLast
          ? cue.cobaltHz
          : null
      return {
        f0,
        onset: onsets[idx] ?? idx * 0.06,
        dur: cue.dur,
        atk: cue.atk,
        gain: isLast ? 1.0 : 0.82,
        pan: 0,
        cobaltHz: cob,
        cobaltTrim: cue.cobaltTrim ?? 1.0,
        damper: Boolean(cue.damper && isLast),
        woodTap: Boolean(cue.knock && idx < 2),
        tier: cue.tier,
      }
    })
    if (cue.extraNote) {
      list.push({
        f0: cue.extraNote.f0,
        onset: cue.extraNote.onset,
        dur: cue.dur,
        atk: cue.atk,
        gain: cue.extraNote.gain,
        pan: 0,
        cobaltHz: null,
        cobaltTrim: 1,
        isHarmony: true,
        tier: cue.tier,
      })
    }
  }

  if (pack === 'souffle') {
    let lastOnset = -1
    list.forEach((ev) => {
      if (!ev.isHarmony) {
        if (lastOnset >= 0 && ev.onset - lastOnset < 0.056) ev.onset = lastOnset + 0.056
        lastOnset = ev.onset
      } else {
        ev.onset = lastOnset
      }
    })
  }
  return list
}

function addPanned(
  rawL: Float64Array,
  rawR: Float64Array,
  s0: number,
  mono: Float64Array,
  pan = 0
): void {
  const angle = (pan + 1) * (Math.PI / 4)
  const gL = Math.SQRT2 * Math.cos(angle)
  const gR = Math.SQRT2 * Math.sin(angle)
  for (let i = 0; i < mono.length && s0 + i < rawL.length; i++) {
    const sample = mono[i] ?? 0
    rawL[s0 + i] = (rawL[s0 + i] ?? 0) + sample * gL
    rawR[s0 + i] = (rawR[s0 + i] ?? 0) + sample * gR
  }
}

function synthNoteGivre(
  rawL: Float64Array,
  rawR: Float64Array,
  s0: number,
  ev: ScoreNoteEvent,
  rng: () => number
): void {
  const total = Math.floor((ev.dur + 0.13) * SR)
  const atkS = Math.max(160, Math.floor(ev.atk * SR))
  const mono = new Float64Array(total)
  const malletS = Math.floor(0.007 * SR)
  const velvet = velvetGen(rng, 2700)
  const feltBP = createSVF(ev.woodTap ? 620 : Math.min(2200, ev.f0 * 3.1), ev.woodTap ? 3.2 : 1.2)
  const bodyBP = createSVF(ev.woodTap ? 340 : ev.f0 * 2.0, 4.5)
  const ratios = [1.0, 2.0, 3.01, 4.98]
  const amps = ev.woodTap ? [0.65, 0.25, 0.04, 0] : [1.0, 0.36, 0.11, 0.045]
  const decs = ev.woodTap ? [0.22, 0.15, 0.08, 0.05] : [1.0, 0.62, 0.25, 0.11]
  const ph = [0, 0.1, 0.2, 0.3]
  let cPh = 0
  for (let i = 0; i < total; i++) {
    const t = i / SR
    const mallet =
      i < malletS
        ? feltBP.step(velvet(i)).bp *
          Math.pow(Math.sin((Math.PI * i) / malletS), 2) *
          (ev.woodTap ? 0.34 : 0.15)
        : 0
    const body = bodyBP.step(mallet).bp * (ev.woodTap ? 0.85 : 0.55)
    const bend = 1 + 0.0045 * Math.exp(-t / 0.01)
    const envA = rcIn(i / atkS)
    const dt = Math.max(0, t - ev.atk)
    const choke = ev.damper && t > ev.dur * 0.68 ? rcOut((t - ev.dur * 0.68) / 0.026) : 1
    const guard = rcOut((i - (total - 640)) / 640)
    let mSum = 0
    for (let m = 0; m < 4; m++) {
      const ratio = ratios[m] ?? 1
      const amp = amps[m] ?? 0
      const dec = decs[m] ?? 1
      const fm = ev.f0 * ratio * bend
      if (fm > 4500 || amp === 0) continue
      const nextPh = (ph[m] ?? 0) + (TWO_PI * fm) / SR
      ph[m] = nextPh
      const cut = fm > 720 && fm < 1950 ? 0.54 : 1.0
      const tau = Math.max(0.018, ev.dur * 0.84 * dec)
      mSum +=
        Math.sin(nextPh) *
        amp *
        cut *
        (0.28 * Math.exp(-dt / (tau * 0.35)) + 0.72 * Math.exp(-dt / tau))
    }
    let cSig = 0
    if (ev.cobaltHz) {
      cPh += (TWO_PI * ev.cobaltHz) / SR
      cSig =
        Math.sin(cPh) *
        0.068 *
        (ev.cobaltTrim ?? 1) *
        rcIn((t - 0.004) / 0.013) *
        Math.exp(-Math.max(0, t - 0.015) / 0.072)
    }
    mono[i] = (mallet + body + (mSum + cSig) * envA) * choke * guard * ev.gain
  }
  addPanned(rawL, rawR, s0, mono, ev.pan || 0)
}

function synthNoteAtelier(
  rawL: Float64Array,
  rawR: Float64Array,
  s0: number,
  ev: ScoreNoteEvent,
  rng: () => number,
  isFirst: boolean
): void {
  const total = Math.floor((ev.dur + 0.15) * SR)
  const atkS = Math.max(220, Math.floor((ev.atk + 0.003) * SR))
  const mono = new Float64Array(total)
  const thumpS = Math.floor(0.012 * SR)
  const velvet = velvetGen(rng, 1900)
  const thumpSVF = createSVF(ev.woodTap ? 290 : Math.max(165, ev.f0 * 0.7), 2.2)
  const roll = createSVF(3100, 0.72)
  let p1a = 0
  let p1b = 0.2
  let pSub = 0
  let p2 = 0
  let p3 = 0
  let pMod = 0
  let pTine = 0
  for (let i = 0; i < total; i++) {
    const t = i / SR
    const thump =
      i < thumpS
        ? thumpSVF.step(velvet(i) + (i < 80 ? 0.3 : 0)).bp *
          Math.pow(Math.sin((Math.PI * i) / thumpS), 2) *
          (ev.woodTap ? 0.36 : 0.18)
        : 0
    const f = ev.f0 * (1 + 0.003 * Math.exp(-t / 0.013))
    p1a += (TWO_PI * (f * 0.9992)) / SR
    p1b += (TWO_PI * (f * 1.0008)) / SR
    pSub += (TWO_PI * (f * 0.5)) / SR
    p2 += (TWO_PI * (f * 2.0014)) / SR
    p3 += (TWO_PI * (f * 3.0045)) / SR
    pMod += (TWO_PI * (f * 2.001)) / SR
    const dt = Math.max(0, t - ev.atk)
    const tau = Math.max(0.03, ev.woodTap ? 0.045 : ev.dur * 0.92)
    const mod = 0.34 * Math.exp(-dt / 0.065) * Math.sin(pMod)
    const sub = isFirst && !ev.woodTap ? 0.19 * Math.sin(pSub) * Math.exp(-dt / (tau * 0.8)) : 0
    const tine =
      0.5 * (Math.sin(p1a + mod) + 0.85 * Math.sin(p1b + mod)) * Math.exp(-dt / tau) +
      0.23 * Math.sin(p2) * Math.exp(-dt / (tau * 0.58)) +
      0.07 * Math.sin(p3) * Math.exp(-dt / (tau * 0.25)) +
      sub
    let cBell = 0
    if (ev.cobaltHz) {
      pTine += (TWO_PI * ev.cobaltHz) / SR
      cBell =
        Math.sin(pTine) *
        0.046 *
        (ev.cobaltTrim ?? 1) *
        rcIn((t - 0.003) / 0.011) *
        Math.exp(-dt / 0.058)
    }
    const choke = ev.damper && t > ev.dur * 0.65 ? rcOut((t - ev.dur * 0.65) / 0.022) : 1
    const guard = rcOut((i - (total - 640)) / 640)
    mono[i] = roll.step((tine * 0.72 + cBell) * rcIn(i / atkS) + thump).lp * choke * guard * ev.gain
  }
  addPanned(rawL, rawR, s0, mono, ev.pan || 0)
}

function synthNoteSouffle(
  rawL: Float64Array,
  rawR: Float64Array,
  s0: number,
  ev: ScoreNoteEvent,
  rng: () => number
): void {
  if (ev.woodTap) {
    const len = Math.floor(0.075 * SR)
    const mono = new Float64Array(len)
    const m1 = createSVF(295, 4.8)
    const m2 = createSVF(860, 3.8)
    let pBody = 0
    for (let i = 0; i < len; i++) {
      const t = i / SR
      const puff = i < 520 ? (rng() + rng() - 1) * Math.sin(Math.PI * (i / 520)) * 0.42 : 0
      pBody += (TWO_PI * 295) / SR
      const body = Math.sin(pBody) * Math.exp(-t / 0.018) * 0.42
      const res =
        m1.step(puff).bp * Math.exp(-t / 0.02) + m2.step(puff).bp * 0.32 * Math.exp(-t / 0.01)
      mono[i] = (body + res) * ev.gain * rcIn(i / 288) * rcOut((i - (len - 480)) / 480)
    }
    addPanned(rawL, rawR, s0, mono, ev.pan || 0)
    return
  }
  const noteDur = Math.min(ev.dur, ev.tier === 0 ? ev.dur * 0.92 : Math.max(0.072, ev.dur * 0.62))
  const total = Math.floor((noteDur + 0.08) * SR)
  const mono = new Float64Array(total)
  const atkS = Math.max(528, Math.floor(Math.max(0.011, ev.atk * 1.65) * SR))
  const breathLenS = Math.floor(Math.min(0.058, noteDur * 0.68) * SR)
  const chiffBP = createSVF(Math.min(2000, Math.max(500, ev.f0 * 2.0)), 2.5)
  const airLP = createSVF(2150, 0.707)
  const vesselLP = createSVF(ev.damper ? 1350 : 2600, 0.72)
  let p1 = 0
  let p2 = 0.25
  let p3 = 0.5
  let pWhistle = 0
  for (let i = 0; i < total; i++) {
    const t = i / SR
    let breath = 0
    if (i < breathLenS) {
      const w =
        rcIn(i / Math.min(672, breathLenS * 0.45)) *
        rcOut((i - breathLenS * 0.45) / (breathLenS * 0.55))
      breath = airLP.step(chiffBP.step(rng() + rng() - 1.0).bp).lp * w * 0.082
    }
    const f = ev.f0 * (1 - 0.0055 * Math.exp(-t / 0.015))
    p1 += (TWO_PI * f) / SR
    p2 += (TWO_PI * (f * 2.0)) / SR
    p3 += (TWO_PI * (f * 2.985)) / SR
    const dt = Math.max(0, t - atkS / SR)
    const tau = Math.max(0.034, noteDur * 0.56)
    const envAtk = rcIn(i / atkS)
    const dampClose = ev.damper && t > noteDur * 0.58 ? rcOut((t - noteDur * 0.58) / 0.028) : 1
    const guard = rcOut((i - (total - 864)) / 864)
    const cavity =
      (Math.sin(p1) * Math.exp(-dt / tau) +
        0.19 * Math.sin(p2) * Math.exp(-dt / (tau * 0.55)) +
        0.12 * Math.sin(p3) * Math.exp(-dt / 0.024)) *
      (1 + breath * 1.3)
    let whistle = 0
    if (ev.cobaltHz) {
      const fW = Math.min(2650, ev.cobaltHz)
      pWhistle += (TWO_PI * fW) / SR
      whistle =
        Math.sin(pWhistle) *
        0.034 *
        (ev.cobaltTrim ?? 1) *
        rcIn((t - 0.006) / 0.016) *
        Math.exp(-dt / 0.044)
    }
    if (ev.damper) vesselLP.set(Math.max(500, 1550 - 1000 * Math.min(1, t / noteDur)), 0.75)
    mono[i] = vesselLP.step((cavity * 0.78 + whistle) * envAtk + breath).lp * dampClose * guard * ev.gain
  }
  addPanned(rawL, rawR, s0, mono, ev.pan || 0)
}

function synthCosmosCue(
  rawL: Float64Array,
  rawR: Float64Array,
  cue: CueSynthSpec,
  evs: ScoreNoteEvent[],
  rng: () => number
): void {
  if (cue.stereoTest) {
    evs.forEach((ev) => {
      const s0 = Math.floor(ev.onset * SR)
      const len = Math.floor((ev.dur + 0.14) * SR)
      const mono = new Float64Array(len)
      const lpg = createSVF(2300, 1.35)
      let ph = 0
      let subPh = 0
      let cPh = 0
      for (let i = 0; i < len; i++) {
        const t = i / SR
        const vac = rcIn(i / 380) * Math.pow(1 + Math.max(0, t - 0.008) / (ev.dur * 0.54), -2.1)
        const fInst = ev.f0 * (1 + 0.0024 * Math.sin(TWO_PI * 5.2 * t))
        ph += (TWO_PI * fInst) / SR
        subPh += (TWO_PI * (fInst * 0.5)) / SR
        const fold = (ev.cobaltHz ? 0.82 : 0.58) * vac
        const raw =
          0.84 * Math.sin((1 + fold) * Math.sin(ph) + 0.22 * fold * Math.sin(2 * ph)) +
          0.16 * Math.sin(subPh)
        lpg.set(290 + (ev.cobaltHz ? 2750 : 2050) * Math.pow(vac, 1.2), 1.35)
        let cob = 0
        if (ev.cobaltHz) {
          cPh += (TWO_PI * ev.cobaltHz) / SR
          cob =
            Math.sin(cPh) *
            0.052 *
            (ev.cobaltTrim ?? 1) *
            rcIn((t - 0.005) / 0.015) *
            Math.exp(-Math.max(0, t - 0.016) / 0.072)
        }
        mono[i] = (lpg.step(raw * vac * ev.gain).lp + cob) * rcOut((i - (len - 720)) / 720)
      }
      addPanned(rawL, rawR, s0, mono, ev.pan || 0)
    })
    return
  }

  const taps = evs.filter((e) => e.woodTap)
  taps.forEach((tap, k) => {
    const s0 = Math.floor(tap.onset * SR)
    const len = Math.floor(0.092 * SR)
    const fB = k === 0 ? 220.0 : 277.0
    const lpg = createSVF(1750, 1.85)
    let ph = 0
    for (let i = 0; i < len && s0 + i < rawL.length; i++) {
      const t = i / SR
      const vac = rcIn(i / 216) * Math.pow(1 + t / 0.019, -2.35)
      ph += (TWO_PI * (fB * (1 + 0.36 * Math.exp(-t / 0.008)))) / SR
      lpg.set(240 + 1950 * vac, 1.65)
      const v =
        lpg.step(Math.sin(ph + 0.65 * vac * Math.sin(ph))).lp *
        vac *
        tap.gain *
        0.85 *
        rcOut((i - (len - 360)) / 360)
      rawL[s0 + i] = (rawL[s0 + i] ?? 0) + v
      rawR[s0 + i] = (rawR[s0 + i] ?? 0) + v
    }
  })

  const mel = evs.filter((e) => !e.woodTap && !e.isHarmony)
  const firstMel = mel[0]
  const lastEv = mel[mel.length - 1]
  if (firstMel && lastEv) {
    const firstOn = firstMel.onset
    const startS = Math.floor(firstOn * SR)
    const endS = Math.min(rawL.length, Math.floor((lastEv.onset + lastEv.dur + 0.15) * SR))
    const lpgSVF = createSVF(900, 1.35)
    const palmeDel = Math.max(24, Math.round(SR / (lastEv.f0 * 2)))
    const palmeBuf = new Float64Array(palmeDel)
    const palmeLP = createSVF(2300, 0.707)
    let pIdx = 0
    let ph = rng() * 0.2
    let subPh = 0
    let cPhL = 0
    let cPhR = 0.4
    for (let i = startS; i < endS; i++) {
      const t = i / SR
      let idx = 0
      while (idx + 1 < mel.length && t >= (mel[idx + 1]?.onset ?? Infinity)) idx++
      const cur = mel[idx] ?? firstMel
      const prev = idx > 0 ? (mel[idx - 1] ?? cur) : cur
      const locT = Math.max(0, t - cur.onset)
      const glideU = idx > 0 ? bezier(Math.min(1, locT / 0.028)) : 1
      let fInst = prev.f0 * Math.pow(cur.f0 / prev.f0, glideU)
      if (cur.damper && locT > cur.dur * 0.55) {
        fInst *= 1 - 0.009 * rcIn((locT - cur.dur * 0.55) / 0.035)
      }
      fInst *= 1 + 0.0026 * rcIn((locT - 0.055) / 0.045) * Math.sin(TWO_PI * 5.3 * t)
      ph += (TWO_PI * fInst) / SR
      subPh += (TWO_PI * (fInst * 0.5)) / SR
      const atkS = Math.max(360, Math.floor(cur.atk * 1.2 * SR))
      const reart = idx > 0 ? 0.44 + 0.56 * rcIn(locT / 0.009) : rcIn((i - startS) / atkS)
      const tauV = Math.max(0.048, cur.dur * 0.54)
      const vac = reart * Math.pow(1 + Math.max(0, locT - 0.009) / tauV, -2.12)
      const choke = cur.damper && locT > cur.dur * 0.66 ? rcOut((locT - cur.dur * 0.66) / 0.03) : 1
      const env = vac * choke * cur.gain * rcOut((i - (endS - 864)) / 864)
      const fold = (cur.cobaltHz ? 0.85 : 0.6) * vac
      const raw =
        0.83 * Math.sin((1 + fold) * Math.sin(ph) + 0.22 * fold * Math.sin(2 * ph)) +
        0.17 * Math.sin(subPh)
      const fcMax = cur.cobaltHz ? 3050 : 2250
      lpgSVF.set(280 + (fcMax - 280) * Math.pow(vac * choke, 1.22), 1.35)
      const gated = lpgSVF.step(raw * env).lp
      const del = palmeBuf[pIdx] ?? 0
      palmeBuf[pIdx] = gated + palmeLP.step(del).lp * (cur.cobaltHz ? 0.26 : 0.16)
      pIdx = (pIdx + 1) % palmeDel
      let cL = 0
      let cR = 0
      if (cur.cobaltHz) {
        cPhL += (TWO_PI * (cur.cobaltHz * 1.0028)) / SR
        cPhR += (TWO_PI * (cur.cobaltHz * 0.9972)) / SR
        const cEnv =
          0.052 *
          (cur.cobaltTrim ?? 1) *
          rcIn((locT - 0.005) / 0.015) *
          Math.exp(-Math.max(0, locT - 0.016) / 0.075) *
          choke
        cL = Math.sin(cPhL) * cEnv
        cR = Math.sin(cPhR) * cEnv
      }
      const base = gated * 0.86 + del * 0.14
      rawL[i] = (rawL[i] ?? 0) + base + cL
      rawR[i] = (rawR[i] ?? 0) + base + cR
    }
  }

  evs
    .filter((e) => e.isHarmony)
    .forEach((h) => {
      const s0 = Math.floor(h.onset * SR)
      const len = Math.floor((h.dur + 0.12) * SR)
      const mono = new Float64Array(len)
      const lpg = createSVF(2200, 1.1)
      let ph = 0
      for (let i = 0; i < len; i++) {
        const t = i / SR
        const vac = rcIn(i / 360) * Math.pow(1 + t / (h.dur * 0.5), -2.1)
        ph += (TWO_PI * h.f0) / SR
        lpg.set(300 + 2100 * vac, 1.1)
        mono[i] =
          lpg.step(Math.sin(ph + 0.5 * vac * Math.sin(ph)) * vac * h.gain).lp *
          rcOut((i - (len - 640)) / 640)
      }
      addPanned(rawL, rawR, s0, mono, h.pan || 0)
    })
}

function synthNoteLuciole(
  rawL: Float64Array,
  rawR: Float64Array,
  s0: number,
  ev: ScoreNoteEvent,
  rng: () => number
): void {
  if (ev.woodTap) {
    const len = Math.floor(0.092 * SR)
    const mono = new Float64Array(len)
    const air = createSVF(230, 5.8)
    const bamboo = createSVF(515, 6.4)
    const tap = createSVF(1580, 3.0)
    for (let i = 0; i < len; i++) {
      const t = i / SR
      const th = i < 300 ? Math.sin(Math.PI * (i / 300)) * (0.65 + 0.35 * (rng() + rng() - 1)) : 0
      const g =
        air.step(th).bp * Math.exp(-t / 0.024) +
        bamboo.step(th).bp * 0.68 * Math.exp(-t / 0.015) +
        tap.step(th).bp * 0.18 * Math.exp(-t / 0.005)
      mono[i] = g * ev.gain * rcIn(i / 180) * rcOut((i - (len - 384)) / 384)
    }
    addPanned(rawL, rawR, s0, mono, ev.pan || 0)
    return
  }
  const total = Math.floor((ev.dur + 0.16) * SR)
  const mono = new Float64Array(total)
  const w0 = (TWO_PI * ev.f0) / SR
  const damp = ev.f0 > 520 ? 0.24 : 0.34
  const dLp = Math.atan2(damp * Math.sin(w0), 1 - damp * Math.cos(w0)) / w0
  const dRem = Math.max(4.5, SR / ev.f0 - dLp)
  const M = Math.floor(dRem - 0.5)
  const delta = dRem - M
  const eta = (1 - delta) / (1 + delta)
  const ringLen = M + 4
  const delayLine = new Float64Array(ringLen)
  const pluckLen = Math.max(192, Math.floor(Math.min(0.009, Math.max(0.0055, ev.atk * 1.1)) * SR))
  const pluckLP = createSVF(Math.min(2400, ev.f0 * 4.5), 0.75)
  const gourdAir = createSVF(235, 3.1)
  const gourdWood = createSVF(495, 3.6)
  const baseFb = Math.min(0.9965, Math.pow(0.001, 1 / Math.max(8, ev.f0 * ev.dur * 2.6)))
  let wIdx = 0
  let lpSt = 0
  let apX = 0
  let apY = 0
  let dropPh = 0
  let fireflyPh = 0
  const fDropBase = Math.min(2500, ev.f0 * (ev.f0 < 360 ? 3.0 : 2.0))
  const dropSlope = ev.damper ? -0.13 : 0.14
  for (let i = 0; i < total; i++) {
    const t = i / SR
    let exc = 0
    if (i < pluckLen) {
      const u = i / pluckLen
      exc =
        pluckLP.step(
          Math.sin(Math.PI * u) * (0.72 * Math.sin(TWO_PI * u) + 0.28 * (rng() + rng() - 1))
        ).lp * 0.55
    }
    const rawDel = delayLine[(wIdx - M + ringLen) % ringLen] ?? 0
    lpSt = (1 - damp) * rawDel + damp * lpSt
    const apOut = eta * (lpSt - apY) + apX
    apX = lpSt
    apY = apOut
    const palmFb =
      ev.damper && t > ev.dur * 0.55
        ? baseFb * (1 - 0.12 * Math.min(1, (t - ev.dur * 0.55) / 0.035))
        : baseFb
    delayLine[wIdx] = exc + apOut * palmFb
    wIdx = (wIdx + 1) % ringLen
    const wah = 1 + 0.12 * Math.sin(TWO_PI * 5.5 * t)
    const gourd = (gourdAir.step(apOut + exc * 0.5).bp * 0.34 + gourdWood.step(apOut).bp * 0.22) * wah
    let drop = 0
    if (t < 0.044) {
      dropPh += (TWO_PI * (fDropBase * (1 + dropSlope * Math.min(1.4, t / 0.022)))) / SR
      drop = Math.sin(dropPh) * rcIn(i / 216) * Math.exp(-t / 0.012) * 0.19
    }
    let firefly = 0
    if (ev.cobaltHz) {
      fireflyPh += (TWO_PI * ev.cobaltHz) / SR
      firefly =
        Math.sin(fireflyPh) *
        0.056 *
        (ev.cobaltTrim ?? 1) *
        rcIn((t - 0.005) / 0.013) *
        Math.exp(-Math.max(0, t - 0.013) / 0.064)
    }
    const guard = rcIn(i / 144) * rcOut((i - (total - 768)) / 768)
    mono[i] = (apOut * 0.82 + gourd + drop + firefly) * guard * ev.gain
  }
  addPanned(rawL, rawR, s0, mono, ev.pan || 0)
}

export interface SynthOptions {
  softenedHighs?: boolean
  mentionVariant?: MentionVariantId
  vip?: boolean
  allowSilencieuxSafetyFallback?: boolean
}

export function synthesizeCue(
  pack: SoundPackId,
  triggerOrSlug: SoundTriggerInput | string,
  options: SynthOptions = {}
): SynthesizedCueResult {
  const resolved = resolveSoundTrigger(
    triggerOrSlug,
    options.mentionVariant ?? 'eclat',
    options.vip ?? false
  )
  const cue: CueSynthSpec =
    resolved?.cue ??
    getCueSpecBySlug(triggerOrSlug) ??
    (resolveSoundTrigger('voice_self_join') as NonNullable<ReturnType<typeof resolveSoundTrigger>>).cue

  if (pack === 'silencieux' && !(options.allowSilencieuxSafetyFallback && cue.tier === 0)) {
    const cacheKey = `silencieux:${cue.slug}:silent`
    const cached = synthCache.get(cacheKey)
    if (cached) return cached
    const silentLen = Math.max(2048, Math.ceil((cue.durationMs / 1000) * SR))
    const empty = new Float32Array(silentLen)
    const silentResult: SynthesizedCueResult = {
      pack: 'silencieux',
      effectivePack: null,
      slug: cue.slug,
      sampleRate: SR,
      mono: empty,
      left: empty,
      right: empty,
      durationMs: cue.durationMs,
      activeMs: 0,
      lufs: -100,
      truePeakDb: -100,
      peakLinear: 0,
      stereoCorrelation: 1,
      cobaltHz: null,
    }
    synthCache.set(cacheKey, silentResult)
    return silentResult
  }

  const effectivePack: AcousticPackId =
    pack === 'silencieux'
      ? SILENCIEUX_SAFETY_PACK
      : ACOUSTIC_PACK_IDS.includes(pack as AcousticPackId)
        ? (pack as AcousticPackId)
        : 'givre'

  const softened = Boolean(options.softenedHighs)
  const cacheKey = `${effectivePack}:${cue.slug}:${softened ? 'soft' : 'std'}`
  const existing = synthCache.get(cacheKey)
  if (existing) return existing

  const prof = PACK_PROFILES[effectivePack]
  const seed = `${effectivePack}:${cue.slug}:v1`
  const rng = splitMix64(seed)
  const evs = resolveScore(cue, effectivePack)
  const lastEnd = Math.max(...evs.map((e) => e.onset + e.dur)) + 0.18
  const N = Math.max(2048, Math.ceil(lastEnd * SR))
  const rawL = new Float64Array(N)
  const rawR = new Float64Array(N)

  if (effectivePack === 'cosmos') {
    synthCosmosCue(rawL, rawR, cue, evs, rng)
  } else {
    evs.forEach((ev, idx) => {
      const s0 = Math.floor(ev.onset * SR)
      if (effectivePack === 'atelier') synthNoteAtelier(rawL, rawR, s0, ev, rng, idx === 0)
      else if (effectivePack === 'souffle') synthNoteSouffle(rawL, rawR, s0, ev, rng)
      else if (effectivePack === 'luciole') synthNoteLuciole(rawL, rawR, s0, ev, rng)
      else synthNoteGivre(rawL, rawR, s0, ev, rng)
    })
  }

  if (cue.hollow) {
    const bpL = createSVF(780, 2.3)
    const bpR = createSVF(780, 2.3)
    for (let i = 0; i < N; i++) {
      const sL = bpL.step(rawL[i] ?? 0)
      const sR = bpR.step(rawR[i] ?? 0)
      rawL[i] = 0.42 * sL.lp + 0.68 * sL.bp
      rawR[i] = 0.42 * sR.lp + 0.68 * sR.bp
    }
  }

  if (cue.lpSweep && effectivePack !== 'cosmos') {
    const [f0, f1] = cue.lpSweep
    const svfL = createSVF(f0, 0.78)
    const svfR = createSVF(f0, 0.78)
    const actN = Math.floor((lastEnd - 0.08) * SR)
    for (let i = 0; i < N; i++) {
      const fc = f0 + (f1 - f0) * bezier(Math.min(1, i / Math.max(1, actN)))
      svfL.set(fc)
      svfR.set(fc)
      rawL[i] = svfL.step(rawL[i] ?? 0).lp
      rawR[i] = svfR.step(rawR[i] ?? 0).lp
    }
  }

  const oL = new Float64Array(N)
  const oR = new Float64Array(N)
  const sHP = createSVF(420, 0.707)
  const hpL = makeHighpass(prof.hpf)
  const hpR = makeHighpass(prof.hpf)
  const valL = makePeaking(1150, 0.85, prof.valleyDb)
  const valR = makePeaking(1150, 0.85, prof.valleyDb)
  const targetLpf = softened ? Math.min(prof.lpf, 2100) : prof.lpf
  const lpL = makeLowpass(targetLpf)
  const lpR = makeLowpass(targetLpf)

  for (let i = 0; i < N; i++) {
    const m353 = i >= 353 ? 0.5 * ((rawL[i - 353] ?? 0) + (rawR[i - 353] ?? 0)) : 0
    const m571 = i >= 571 ? 0.5 * ((rawL[i - 571] ?? 0) + (rawR[i - 571] ?? 0)) : 0
    const side = sHP.step(m353 * 0.56 - m571 * 0.44).hp * prof.erAlpha
    oL[i] = lpL(valL(hpL((rawL[i] ?? 0) + side)))
    oR[i] = lpR(valR(hpR((rawR[i] ?? 0) - side)))
  }

  const tail = Math.min(720, Math.floor(N * 0.2))
  for (let i = 0; i < N; i++) {
    const g = (i < 128 ? rcIn(i / 128) : 1) * (i >= N - tail ? rcOut((i - (N - tail)) / tail) : 1)
    oL[i] = (oL[i] ?? 0) * g
    oR[i] = (oR[i] ?? 0) * g
  }

  const curLufs = measureBS1770LUFS(oL, oR)
  const tgtLufs = cue.lufs + prof.lufsOffset
  let mg = Math.pow(10, (tgtLufs - curLufs) / 20)
  const preTp = Math.max(hermitePeak4x(oL), hermitePeak4x(oR))
  const ceiling =
    cue.toggle || (effectivePack === 'souffle' && cue.tier !== 0) ? prof.tpToggle : prof.tpFull
  if (preTp * mg > ceiling) mg = ceiling / Math.max(1e-9, preTp)

  const left = new Float32Array(N)
  const right = new Float32Array(N)
  const mono = new Float32Array(N)

  let lastAct = 0
  let sumLR = 0
  let sumLL = 0
  let sumRR = 0
  let peakLinear = 0

  for (let i = 0; i < N; i++) {
    const boundaryZero = i === 0 || i === N - 1
    const edgeWindow = i < 32 ? rcIn(i / 32) : i >= N - 32 ? rcOut((i - (N - 32)) / 31) : 1
    const sL = boundaryZero
      ? 0
      : Math.max(-0.99, Math.min(0.99, (oL[i] ?? 0) * mg * edgeWindow))
    const sR = boundaryZero
      ? 0
      : Math.max(-0.99, Math.min(0.99, (oR[i] ?? 0) * mg * edgeWindow))
    oL[i] = sL
    oR[i] = sR
    left[i] = sL
    right[i] = sR
    // For stereo speaker test, preserve full energy in mono fold-down
    const m = Math.max(-0.99, Math.min(0.99, 0.5 * (sL + sR)))
    mono[i] = m

    const maxSample = Math.max(Math.abs(sL), Math.abs(sR), Math.abs(m))
    if (maxSample > peakLinear) peakLinear = maxSample
    if (maxSample > 0.0015) lastAct = i
    sumLR += sL * sR
    sumLL += sL * sL
    sumRR += sR * sR
  }

  const finalLufs = Number(measureBS1770LUFS(oL, oR).toFixed(2))
  const finalTpDb = Number(
    (20 * Math.log10(Math.max(1e-9, Math.max(hermitePeak4x(oL), hermitePeak4x(oR))))).toFixed(2)
  )
  const stereoCorrelation = Number((sumLR / Math.max(1e-12, Math.sqrt(sumLL * sumRR))).toFixed(4))
  const activeMs = Math.round((lastAct / SR) * 1000)
  const cobaltHz = evs.find((e) => e.cobaltHz !== null)?.cobaltHz ?? null

  const result: SynthesizedCueResult = {
    pack,
    effectivePack,
    slug: cue.slug,
    sampleRate: SR,
    mono,
    left,
    right,
    durationMs: cue.durationMs,
    activeMs,
    lufs: finalLufs,
    truePeakDb: finalTpDb,
    peakLinear,
    stereoCorrelation,
    cobaltHz,
  }

  synthCache.set(cacheKey, result)
  return result
}

export function synthesizeCuePcm(
  pack: SoundPackId,
  triggerOrSlug: SoundTriggerInput | string,
  options: SynthOptions = {}
): Float32Array {
  return synthesizeCue(pack, triggerOrSlug, options).mono
}

export function createCueAudioBuffer(
  ctx: BaseAudioContext,
  pack: SoundPackId,
  triggerOrSlug: SoundTriggerInput | string,
  options: SynthOptions = {}
): AudioBuffer {
  const res = synthesizeCue(pack, triggerOrSlug, options)
  const channels = res.slug === 'settings-speaker-test' || res.pack === 'cosmos' ? 2 : 1
  const buffer = ctx.createBuffer(channels, res.mono.length, res.sampleRate)
  if (channels === 2) {
    buffer.getChannelData(0).set(res.left)
    buffer.getChannelData(1).set(res.right)
  } else {
    buffer.getChannelData(0).set(res.mono)
  }
  return buffer
}

export function measurePeak(samples: Float32Array): number {
  let max = 0
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i] ?? 0)
    if (abs > max) max = abs
  }
  return max
}

export function measureRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    sumSq += v * v
  }
  return Math.sqrt(sumSq / samples.length)
}

/**
 * Deterministic compact FNV-1a 64-bit hex digest of Float32Array quantized frames.
 */
export function waveformSignature(samples: Float32Array): string {
  let h = 0xcbf29ce484222325n
  const step = Math.max(1, Math.floor(samples.length / 512))
  for (let i = 0; i < samples.length; i += step) {
    const q = Math.round((samples[i] ?? 0) * 32767) & 0xffff
    h = ((h ^ BigInt(q & 0xff)) * 0x100000001b3n) & MASK64
    h = ((h ^ BigInt((q >> 8) & 0xff)) * 0x100000001b3n) & MASK64
  }
  return h.toString(16).padStart(16, '0')
}
