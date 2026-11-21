/** Caseless document-title keys, byte-identical to `apps/docs/titles.py` `key()`:
 * NFC, Unicode full case folding, NFC. Normalization and folding both run against the
 * generated Python `unicodedata` tables so Node's ICU version cannot drift from Core. */
import { COMBINING_CLASSES, COMPOSITIONS, DECOMPOSITIONS, FOLDS, PAIR_STRIDE } from './title-key-table.mjs'

const S_BASE = 0xAC00, L_BASE = 0x1100, V_BASE = 0x1161, T_BASE = 0x11A7
const L_COUNT = 19, V_COUNT = 21, T_COUNT = 28
const N_COUNT = V_COUNT * T_COUNT, S_COUNT = L_COUNT * N_COUNT

function composePair(left, right) {
  if (left >= L_BASE && left < L_BASE + L_COUNT && right >= V_BASE && right < V_BASE + V_COUNT) {
    return S_BASE + ((left - L_BASE) * V_COUNT + (right - V_BASE)) * T_COUNT
  }
  if (left >= S_BASE && left < S_BASE + S_COUNT && (left - S_BASE) % T_COUNT === 0 && right > T_BASE && right < T_BASE + T_COUNT) {
    return left + (right - T_BASE)
  }
  return COMPOSITIONS.get(left * PAIR_STRIDE + right) ?? -1
}

export function nfc(value) {
  const decomposed = []
  let nonAscii = false
  for (const character of value) {
    const point = character.codePointAt(0)
    if (point >= 0x80) nonAscii = true
    if (point >= S_BASE && point < S_BASE + S_COUNT) {
      const index = point - S_BASE
      decomposed.push(L_BASE + Math.trunc(index / N_COUNT), V_BASE + Math.trunc((index % N_COUNT) / T_COUNT))
      const trailing = index % T_COUNT
      if (trailing) decomposed.push(T_BASE + trailing)
    } else {
      const mapped = DECOMPOSITIONS.get(point)
      if (mapped) decomposed.push(...mapped)
      else decomposed.push(point)
    }
  }
  if (!nonAscii) return value
  for (let index = 1; index < decomposed.length; index++) {
    const ccc = COMBINING_CLASSES.get(decomposed[index]) ?? 0
    if (ccc > 0) {
      for (let cursor = index; cursor > 0; cursor--) {
        const previous = COMBINING_CLASSES.get(decomposed[cursor - 1]) ?? 0
        if (previous === 0 || previous <= ccc) break
        const swap = decomposed[cursor]
        decomposed[cursor] = decomposed[cursor - 1]
        decomposed[cursor - 1] = swap
      }
    }
  }
  const out = []
  let starter = -1, lastCcc = -1
  for (const point of decomposed) {
    const ccc = COMBINING_CLASSES.get(point) ?? 0
    if (starter >= 0 && lastCcc < ccc) {
      const merged = composePair(out[starter], point)
      if (merged >= 0) {
        out[starter] = merged
        continue
      }
    }
    if (ccc === 0) {
      starter = out.length
      lastCcc = -1
    } else {
      lastCcc = ccc
    }
    out.push(point)
  }
  let result = ''
  for (const point of out) result += String.fromCodePoint(point)
  return result
}

export function titleKey(value) {
  let folded = ''
  for (const character of nfc(value)) folded += FOLDS.get(character.codePointAt(0)) ?? character
  return nfc(folded)
}
