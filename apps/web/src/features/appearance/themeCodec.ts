// The `kodera-theme:v1:` share-code format, strict in both directions. It mirrors the Rust codec
// (`packages/kodera-rs/src/workspace_prefs.rs`, `encode_shareable_theme` / `decode_shareable_theme`)
// byte for byte: a code is accepted here exactly when the Rust decoder accepts it, and the encoder
// emits the same canonical JSON. A decoded theme is applied to the document, so nothing the encoder
// could not have produced is let through: no unknown, missing or duplicated field, no colour other
// than a canonical `rgb(r, g, b)`, no id outside a short lowercase slug.

export type CoreThemeMode = 'light' | 'dark' | 'black'

export interface CustomThemeTokens {
  readonly '--c-page': string
  readonly '--c-surface': string
  readonly '--c-sunken': string
  readonly '--c-action': string
  readonly '--c-ink': string
}

export interface CommunityThemeDefinition {
  readonly id: string
  readonly name: string
  readonly author: string
  readonly baseMode: CoreThemeMode
  readonly tokens: CustomThemeTokens
}

export const THEME_SHARE_PREFIX = 'kodera-theme:v1:'
export const MAX_THEME_SHARE_CODE_BYTES = 2048
export const MAX_THEME_ID_BYTES = 64
export const MAX_THEME_TEXT_BYTES = 64

export const CUSTOM_TOKEN_KEYS: readonly (keyof CustomThemeTokens)[] = [
  '--c-page',
  '--c-surface',
  '--c-sunken',
  '--c-action',
  '--c-ink',
] as const

const ROOT_KEYS = ['v', 'id', 'name', 'author', 'baseMode', 'tokens'] as const

/** Why a code, a stored theme or a theme about to be encoded was refused. */
export type ThemeRefusal =
  | 'too-long'
  | 'prefix'
  | 'base64'
  | 'utf8'
  | 'json'
  | 'duplicate-field'
  | 'unknown-field'
  | 'missing-field'
  | 'field-type'
  | 'version'
  | 'id'
  | 'name'
  | 'author'
  | 'base-mode'
  | 'colour'

export type ThemeDecodeResult =
  | { readonly ok: true; readonly theme: CommunityThemeDefinition }
  | { readonly ok: false; readonly reason: ThemeRefusal }

export type ThemeEncodeResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: ThemeRefusal }

class Refused extends Error {
  constructor(readonly reason: ThemeRefusal) {
    super(reason)
  }
}

const utf8Encoder = new TextEncoder()

function utf8Length(value: string): number {
  return utf8Encoder.encode(value).length
}

// The Rust `forbidden` set: Unicode control characters (Cc) and the pinned format controls.
function isForbiddenCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x00ad ||
    (cp >= 0x0600 && cp <= 0x0605) ||
    cp === 0x061c ||
    cp === 0x06dd ||
    cp === 0x070f ||
    (cp >= 0x0890 && cp <= 0x0891) ||
    cp === 0x08e2 ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    cp === 0x110bd ||
    cp === 0x110cd ||
    (cp >= 0x13430 && cp <= 0x1343f) ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) ||
    cp === 0xe0001 ||
    (cp >= 0xe0020 && cp <= 0xe007f)
  )
}

/** A name or an author: non-empty, at most 64 UTF-8 bytes, no outer space, no control character. */
export function isValidThemeText(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return false
  if (utf8Length(value) > MAX_THEME_TEXT_BYTES) return false
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0
    // A lone surrogate cannot travel as UTF-8; the encoder could not emit it.
    if (cp >= 0xd800 && cp <= 0xdfff) return false
    if (isForbiddenCodePoint(cp)) return false
  }
  return true
}

/** An id: 1 to 64 characters of `a-z`, `0-9` and `-`. */
export function isValidThemeId(value: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(value)
}

const CHANNEL = /^(0|[1-9][0-9]{0,2})$/

/** The one colour form the encoder emits: `rgb(r, g, b)`, decimal 0–255, no leading zero. */
export function isCanonicalRgb(value: string): boolean {
  if (!value.startsWith('rgb(') || !value.endsWith(')')) return false
  const parts = value.slice(4, -1).split(', ')
  if (parts.length !== 3) return false
  return parts.every((part) => CHANNEL.test(part) && Number(part) <= 255)
}

function isCoreThemeMode(value: string): value is CoreThemeMode {
  return value === 'light' || value === 'dark' || value === 'black'
}

/** Every field of a theme, in the order the decoder checks it; `null` when it can be encoded. */
export function validateThemeDefinition(theme: CommunityThemeDefinition): ThemeRefusal | null {
  if (!isValidThemeId(theme.id)) return 'id'
  if (!isValidThemeText(theme.name)) return 'name'
  if (!isValidThemeText(theme.author)) return 'author'
  if (!isCoreThemeMode(theme.baseMode)) return 'base-mode'
  for (const key of CUSTOM_TOKEN_KEYS) {
    if (!isCanonicalRgb(theme.tokens[key])) return 'colour'
  }
  return null
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += BASE64_ALPHABET[a >> 2]
    out += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? BASE64_ALPHABET[c & 63] : '='
  }
  return out
}

// Standard alphabet, padded, and canonical: the unused bits of the last group must be zero, so a
// payload has exactly one spelling — the Rust `base64_decode`.
function base64Decode(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null
  const sextet = (char: string | undefined): number | null => {
    if (char === undefined) return null
    const index = BASE64_ALPHABET.indexOf(char)
    return index < 0 ? null : index
  }
  const out: number[] = []
  for (let i = 0; i < value.length; i += 4) {
    const last = i + 4 === value.length
    const c0 = value[i]
    const c1 = value[i + 1]
    const c2 = value[i + 2]
    const c3 = value[i + 3]
    const a = sextet(c0)
    const b = sextet(c1)
    if (a === null || b === null) return null
    const d = c2 === '=' ? 0 : sextet(c2)
    const e = c3 === '=' ? 0 : sextet(c3)
    if (d === null || e === null) return null
    if (
      (c2 === '=' && (c3 !== '=' || !last || (b & 15) !== 0)) ||
      (c3 === '=' && (!last || (d & 3) !== 0))
    ) {
      return null
    }
    out.push(((a << 2) | (b >> 4)) & 0xff)
    if (c2 !== '=') out.push(((b << 4) | (d >> 2)) & 0xff)
    if (c3 !== '=') out.push(((d << 6) | e) & 0xff)
  }
  return Uint8Array.from(out)
}

// The Rust `quoted`: JSON string escaping, nothing escaped beyond what JSON requires.
function quoted(value: string): string {
  let out = '"'
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f))
      out += `\\u${cp.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

export function encodeShareableTheme(theme: CommunityThemeDefinition): ThemeEncodeResult {
  const invalid = validateThemeDefinition(theme)
  if (invalid !== null) return { ok: false, reason: invalid }
  const t = theme.tokens
  const json =
    `{"v":1,"id":${quoted(theme.id)},"name":${quoted(theme.name)},"author":${quoted(theme.author)},` +
    `"baseMode":${quoted(theme.baseMode)},"tokens":{"--c-page":${quoted(t['--c-page'])},` +
    `"--c-surface":${quoted(t['--c-surface'])},"--c-sunken":${quoted(t['--c-sunken'])},` +
    `"--c-action":${quoted(t['--c-action'])},"--c-ink":${quoted(t['--c-ink'])}}}`
  const code = `${THEME_SHARE_PREFIX}${base64Encode(utf8Encoder.encode(json))}`
  if (code.length > MAX_THEME_SHARE_CODE_BYTES) return { ok: false, reason: 'too-long' }
  return { ok: true, code }
}

// A JSON value as far as the theme format cares: a string, an object, or any other token, kept
// as its raw text so `1` can be told from `1.0`, `10` or `true`.
type JsonNode =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, JsonNode> }
  | { readonly kind: 'other'; readonly raw: string }

class StrictJsonReader {
  private offset = 0

  constructor(private readonly raw: string) {}

  document(): JsonNode {
    const node = this.value()
    this.whitespace()
    if (this.offset !== this.raw.length) throw new Refused('json')
    return node
  }

  private peek(): string | undefined {
    return this.raw[this.offset]
  }

  private whitespace(): void {
    while (
      this.peek() === ' ' ||
      this.peek() === '\n' ||
      this.peek() === '\r' ||
      this.peek() === '\t'
    ) {
      this.offset += 1
    }
  }

  private expect(char: string): void {
    if (this.peek() !== char) throw new Refused('json')
    this.offset += 1
  }

  private value(): JsonNode {
    this.whitespace()
    const next = this.peek()
    if (next === '"') return { kind: 'string', value: this.string() }
    if (next === '{') return this.object()
    if (next === '[') return this.array()
    const match = /^(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(
      this.raw.slice(this.offset)
    )
    if (match === null) throw new Refused('json')
    this.offset += match[0].length
    return { kind: 'other', raw: match[0] }
  }

  private array(): JsonNode {
    const start = this.offset
    this.expect('[')
    this.whitespace()
    if (this.peek() !== ']') {
      for (;;) {
        this.value()
        this.whitespace()
        if (this.peek() === ',') {
          this.offset += 1
          continue
        }
        break
      }
    }
    this.expect(']')
    return { kind: 'other', raw: this.raw.slice(start, this.offset) }
  }

  private object(): JsonNode {
    this.expect('{')
    this.whitespace()
    const fields = new Map<string, JsonNode>()
    if (this.peek() !== '}') {
      for (;;) {
        this.whitespace()
        const key = this.string()
        if (fields.has(key)) throw new Refused('duplicate-field')
        this.whitespace()
        this.expect(':')
        fields.set(key, this.value())
        this.whitespace()
        if (this.peek() === ',') {
          this.offset += 1
          continue
        }
        break
      }
    }
    this.expect('}')
    return { kind: 'object', fields }
  }

  private hex4(): number {
    const digits = this.raw.slice(this.offset, this.offset + 4)
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Refused('json')
    this.offset += 4
    return parseInt(digits, 16)
  }

  private string(): string {
    this.expect('"')
    let out = ''
    for (;;) {
      const cp = this.raw.codePointAt(this.offset)
      if (cp === undefined) throw new Refused('json')
      const char = String.fromCodePoint(cp)
      this.offset += char.length
      if (char === '"') return out
      if (cp < 0x20) throw new Refused('json')
      if (char !== '\\') {
        out += char
        continue
      }
      const escape = this.peek()
      this.offset += 1
      switch (escape) {
        case '"':
        case '\\':
        case '/':
          out += escape
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case 't':
          out += '\t'
          break
        case 'u': {
          let unit = this.hex4()
          if (unit >= 0xd800 && unit <= 0xdbff) {
            this.expect('\\')
            this.expect('u')
            const low = this.hex4()
            if (low < 0xdc00 || low > 0xdfff) throw new Refused('json')
            unit = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new Refused('json')
          }
          out += String.fromCodePoint(unit)
          break
        }
        default:
          throw new Refused('json')
      }
    }
  }
}

function exactFields(fields: ReadonlyMap<string, JsonNode>, expected: readonly string[]): void {
  for (const key of fields.keys()) {
    if (!expected.includes(key)) throw new Refused('unknown-field')
  }
  for (const key of expected) {
    if (!fields.has(key)) throw new Refused('missing-field')
  }
}

function text(fields: ReadonlyMap<string, JsonNode>, key: string): string {
  const node = fields.get(key)
  if (node?.kind !== 'string') throw new Refused('field-type')
  return node.value
}

function themeFromNode(node: JsonNode): CommunityThemeDefinition {
  if (node.kind !== 'object') throw new Refused('field-type')
  exactFields(node.fields, ROOT_KEYS)
  const version = node.fields.get('v')
  if (version?.kind !== 'other' || version.raw !== '1') throw new Refused('version')
  const id = text(node.fields, 'id')
  const name = text(node.fields, 'name')
  const author = text(node.fields, 'author')
  const baseMode = text(node.fields, 'baseMode')
  const tokensNode = node.fields.get('tokens')
  if (tokensNode?.kind !== 'object') throw new Refused('field-type')
  exactFields(tokensNode.fields, CUSTOM_TOKEN_KEYS)
  const tokens: CustomThemeTokens = {
    '--c-page': text(tokensNode.fields, '--c-page'),
    '--c-surface': text(tokensNode.fields, '--c-surface'),
    '--c-sunken': text(tokensNode.fields, '--c-sunken'),
    '--c-action': text(tokensNode.fields, '--c-action'),
    '--c-ink': text(tokensNode.fields, '--c-ink'),
  }
  if (!isCoreThemeMode(baseMode)) throw new Refused('base-mode')
  const theme: CommunityThemeDefinition = { id, name, author, baseMode, tokens }
  const invalid = validateThemeDefinition(theme)
  if (invalid !== null) throw new Refused(invalid)
  return theme
}

/**
 * Decodes a share code exactly as given: no trimming, the 2048-byte bound applied to the whole
 * input first. Every refusal says which rule it broke.
 */
export function decodeShareableTheme(rawCode: string): ThemeDecodeResult {
  if (utf8Length(rawCode) > MAX_THEME_SHARE_CODE_BYTES) return { ok: false, reason: 'too-long' }
  if (!rawCode.startsWith(THEME_SHARE_PREFIX)) return { ok: false, reason: 'prefix' }
  const bytes = base64Decode(rawCode.slice(THEME_SHARE_PREFIX.length))
  if (bytes === null) return { ok: false, reason: 'base64' }
  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'utf8' }
  }
  try {
    return { ok: true, theme: themeFromNode(new StrictJsonReader(json).document()) }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    throw error
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}

/**
 * One theme read back from local storage: the same field set and the same rules as a share code
 * (without the version field, which storage never carried), or `null` — an invalid entry is
 * dropped, never applied.
 */
export function parseStoredTheme(value: unknown): CommunityThemeDefinition | null {
  if (!isPlainRecord(value)) return null
  if (!hasExactKeys(value, ['id', 'name', 'author', 'baseMode', 'tokens'])) return null
  const { id, name, author, baseMode, tokens } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof author !== 'string') return null
  if (typeof baseMode !== 'string' || !isCoreThemeMode(baseMode)) return null
  if (!isPlainRecord(tokens) || !hasExactKeys(tokens, CUSTOM_TOKEN_KEYS)) return null
  const colours = CUSTOM_TOKEN_KEYS.map((key) => tokens[key])
  if (!colours.every((colour): colour is string => typeof colour === 'string')) return null
  const theme: CommunityThemeDefinition = {
    id,
    name,
    author,
    baseMode,
    tokens: {
      '--c-page': colours[0]!,
      '--c-surface': colours[1]!,
      '--c-sunken': colours[2]!,
      '--c-action': colours[3]!,
      '--c-ink': colours[4]!,
    },
  }
  return encodeShareableTheme(theme).ok ? theme : null
}

/** The saved-theme library from its raw storage value; anything unreadable reads as empty. */
export function parseStoredThemes(raw: string | null): readonly CommunityThemeDefinition[] {
  if (raw === null || raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const themes: CommunityThemeDefinition[] = []
  for (const entry of parsed) {
    const theme = parseStoredTheme(entry)
    if (theme !== null) themes.push(theme)
  }
  return themes
}

/** A theme id from a free-text name: `custom-` and a bounded lowercase slug. */
export function themeIdFromName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const id = `custom-${slug}`.slice(0, MAX_THEME_ID_BYTES).replace(/-+$/g, '')
  return id === 'custom' ? 'custom-theme' : id
}
