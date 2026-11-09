import { isUtf8 } from 'node:buffer'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// The product is Kodera (workspace brand rule, owner decision 2026-09-13).
// This module finds the previous product name on the surfaces a customer reads
// before any screen renders — the tab title, the installed-app name, the icon's
// accessible name — and in the copy catalogues every screen draws from.
//
// Frozen: a new evasion shape is recorded as a known gap here and in the pull
// request that met it, not answered with more guard code. Known gaps: look-alike
// letters from other scripts; a name split across JSX expressions or SVG
// elements; UTF-16 files; percent-encoded, upper-case (`;BASE64,`) or
// line-wrapped base64 `data:` URIs; compressed chunks inside a `data:` PNG, after
// a PNG's IEND or behind an overrunning chunk length; numeric references with
// leading zeros; named invisible entities outside the listed ones; and every
// file outside `brandSurface`.

/** The copy catalogues: the fr/en sources and the JSON generated from them. */
export const CATALOGUES: readonly string[] = [
  'docs/specs/copy/fr.md',
  'docs/specs/copy/en.md',
  'src/i18n/fr.json',
  'src/i18n/en.json',
]

/**
 * Every file the guard reads, relative to the repository root. `public/` is
 * walked whole, binaries included: Vite copies it into every build verbatim,
 * and an SVG attribute or a PNG's uncompressed text chunk (`tEXt`, Latin-1;
 * `iTXt`, UTF-8) is as public as a `<title>`. A compressed text chunk is not
 * inflated: `compressedTextChunks` fails the suite on one instead.
 * The generated catalogues are read as well as their sources, so a stale
 * regeneration cannot ship what the source no longer says.
 */
export function brandSurface(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? walk(path) : [path]
      })
      // Directory order is the filesystem's: sorted, so every platform reports alike.
      .sort()
  return [
    join(root, 'index.html'),
    ...walk(join(root, 'public')),
    ...CATALOGUES.map((file) => join(root, file)),
    // The source files that print the product's name on the login and
    // second-factor screens: the login wordmark, the authenticator app's
    // issuer, the recovery-codes file name. Named one by one: a scan of every
    // file under src/ would meet hostnames, storage keys, problem-type URIs and
    // a realm name — identifiers and contract values, not the product speaking
    // — and could only pass with an allow-list that stops meaning « legal
    // entity only ».
    join(root, 'src/features/login/LoginScreen.tsx'),
    join(root, 'src/features/security/mock/MfaEnrolSimulation.tsx'),
    join(root, 'src/features/security/mock/totp.ts'),
  ].map((path) => relative(root, path))
}

const codePoint = (hex: string, whole: string) => {
  const value = Number.parseInt(hex, 16)
  return value <= 0x10ffff ? String.fromCodePoint(value) : whole
}

/**
 * The escapes a hand-written file can spell a letter with: JSON and JS
 * (`\u00ef`, `\u{ef}`, `\xef`) and HTML (`&#239;`, `&#xef;`, `&iuml;`). HTML
 * also renders a numeric reference and a legacy named one without its `;`
 * (`&#239`, `&iuml`), so the `;` is optional. A named accent entity becomes
 * its bare letter — `fold` drops the accent anyway — and a named invisible one
 * (`&shy;`, `&ZeroWidthSpace;`) becomes nothing.
 */
function decodeEscapes(text: string): string {
  return text
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (whole, hex: string) => codePoint(hex, whole))
    .replace(/\\u([0-9a-f]{4})/gi, (whole, hex: string) => codePoint(hex, whole))
    .replace(/\\x([0-9a-f]{2})/gi, (whole, hex: string) => codePoint(hex, whole))
    .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, hex: string) => codePoint(hex, whole))
    .replace(/&#(\d{1,7});?/g, (whole, dec: string) =>
      codePoint(Number.parseInt(dec, 10).toString(16), whole)
    )
    .replace(/&([a-z])(?:uml|acute|grave|circ|tilde|ring|cedil);?/gi, '$1')
    .replace(/&(?:shy|zwj|zwnj|lrm|rlm|ZeroWidthSpace|NoBreak|InvisibleTimes);?/g, '')
}

/**
 * Case- and diacritic-folded, so « Samouraï », « SAMOURAÏ » and an `i`
 * followed by a combining U+0308 all read as `samourai`. An ASCII grep misses
 * the first two; a grep for the precomposed `ï` misses the third. Escapes are
 * decoded first; compatibility forms (fullwidth `ＳＡＭＯＵＲＡＩ`) fold to
 * their letters, and invisible format characters (a zero-width space inside
 * the word) are dropped.
 */
export function fold(text: string): string {
  return decodeEscapes(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Cf}/gu, '')
}

/** The previous product name, with the domain it was sold under when present. */
const LEGACY = /samourai(?:\.[a-z]+)?/gi

/**
 * Legal-entity phrases, and nothing else, each bound to the one catalogue key
 * that may print it. The brand rule keeps the legal entity's name where law or
 * a contract requires it — invoice issuer, contracting party, data controller,
 * legal notice. A product-brand use never belongs here: a team, a badge, a
 * title or a hostname is the product speaking, and the same phrase on any
 * other key's row, or in prose, is found like any other. So catalogue prose (a
 * Changelog line) cannot quote the entity's name: describe it instead.
 * Matched on folded text, capitalised as the registered name is.
 */
export const LEGAL_ENTITY_PHRASES: readonly { key: string; phrase: RegExp; why: string }[] = [
  {
    // « Émises par Samouraï Coop via Qonto · Factur-X »: the issuer printed on
    // a Factur-X invoice is the legal entity, and the console repeats who
    // issues it.
    key: 'console.invoices.list.hint-issuer',
    phrase: /\bSamourai Coop\b/g,
    why: 'invoice issuer',
  },
]

/** True when `line` of `file` is `key`'s own row: its table row in a catalogue source, or its JSON entry. */
export function isRowOf(key: string, file: string, line: string): boolean {
  if (!CATALOGUES.includes(file)) return false
  return file.endsWith('.md')
    ? line.startsWith(`| \`${key}\` |`)
    : line.trimStart().startsWith(`"${key}":`)
}

function scan(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, index) => {
    let folded = fold(line)
    for (const { key, phrase } of LEGAL_ENTITY_PHRASES) {
      if (isRowOf(key, file, line)) folded = folded.replace(phrase, '')
    }
    return [...folded.matchAll(LEGACY)].map(
      (match) => `${file}:${index + 1}: ${match[0]} — ${line.trim().slice(0, 100)}`
    )
  })
}

/** Every reading of `bytes`: UTF-8, plus Latin-1 when it is not UTF-8. */
function scanBytes(file: string, bytes: Buffer): string[] {
  const found = scan(file, bytes.toString('utf8'))
  if (isUtf8(bytes)) return found
  const where = (line: string) => line.split(' — ')[0]
  const seen = new Set(found.map(where))
  return [...found, ...scan(file, bytes.toString('latin1')).filter((l) => !seen.has(where(l)))]
}

/** A base64 `data:` URI inlines a whole file — an image, a font — in an attribute. */
const DATA_URI = /data:[\w.+/-]*(?:;[\w.+-]+=[\w.+-]+)*;base64,([A-Za-z0-9+/]+={0,2})/g

/**
 * One line per occurrence: `path:line: needle — context`. An empty list is
 * the only passing answer. A file that is not UTF-8 — a PNG, the `.ico` — is
 * read twice: as UTF-8 (an `iTXt` chunk's encoding) and as Latin-1 (a `tEXt`
 * chunk's, where « ï » is the lone byte 0xEF); a hit either reading finds is
 * reported once. A base64 `data:` URI's payload is decoded and read the same
 * way, and a hit in it is reported at the URI's line.
 */
export function findLegacyBrand(root: string, files: readonly string[]): string[] {
  return files.flatMap((file) => {
    const bytes = readFileSync(join(root, file))
    const inlined = bytes
      .toString('utf8')
      .split('\n')
      .flatMap((line, index) =>
        [...line.matchAll(DATA_URI)].flatMap((match) =>
          scanBytes(`${file} (data: URI)`, Buffer.from(match[1] ?? '', 'base64')).map((hit) =>
            hit.replace(/^(.*?) \(data: URI\):\d+:/, `$1:${index + 1}: (data: URI)`)
          )
        )
      )
    return [...scanBytes(file, bytes), ...inlined]
  })
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The chunk types and data of the PNG starting at `at`, up to IEND or the end of the bytes. */
function pngChunks(bytes: Buffer, at: number): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = []
  for (let pos = at + 8; pos + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(pos)
    const type = bytes.toString('latin1', pos + 4, pos + 8)
    chunks.push({ type, data: bytes.subarray(pos + 8, pos + 8 + length) })
    if (type === 'IEND') break
    pos += 12 + length
  }
  return chunks
}

/** The offsets of every PNG in `bytes`: the file itself, or each PNG frame of an `.ico`. */
function pngOffsets(bytes: Buffer): number[] {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return [0]
  const isIco = bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1
  if (!isIco) return []
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => 6 + 16 * i)
    .filter((entry) => entry + 16 <= bytes.length)
    .map((entry) => bytes.readUInt32LE(entry + 12))
    .filter((offset) => bytes.subarray(offset, offset + 8).equals(PNG_SIGNATURE))
}

/**
 * The files holding a PNG text chunk the guard cannot read: `zTXt`, or an
 * `iTXt` whose compression flag is set. Both are deflated, so the name inside
 * is invisible to `findLegacyBrand`. Only real PNG chunks count — a PNG file's,
 * or a PNG frame's inside an `.ico` — so a note that merely spells `zTXt` does not.
 */
export function compressedTextChunks(root: string, files: readonly string[]): string[] {
  return files.filter((file) => {
    const bytes = readFileSync(join(root, file))
    return pngOffsets(bytes).some((offset) =>
      pngChunks(bytes, offset).some(
        ({ type, data }) =>
          type === 'zTXt' ||
          // iTXt: keyword, NUL, compression flag, …
          (type === 'iTXt' && data[data.indexOf(0) + 1] !== 0)
      )
    )
  })
}
