import { describe, expect, it } from 'vitest'
import {
  MAX_THEME_SHARE_CODE_BYTES,
  THEME_SHARE_PREFIX,
  decodeShareableTheme,
  encodeShareableTheme,
  parseStoredThemes,
  themeIdFromName,
  type CommunityThemeDefinition,
  type ThemeRefusal,
} from './themeCodec'

// The canonical fixture the Rust codec pins in
// packages/kodera-rs/src/workspace_prefs.rs (`curated_presets_and_shared_canonical_fixture_round_trip`).
const RUST_FIXTURE_JSON =
  '{"v":1,"id":"preset-real-black-oled","name":"Real Black OLED","author":"Kodera Design System","baseMode":"black","tokens":{"--c-page":"rgb(0, 0, 0)","--c-surface":"rgb(11, 12, 14)","--c-sunken":"rgb(6, 6, 7)","--c-action":"rgb(67, 97, 238)","--c-ink":"rgb(241, 244, 248)"}}'

const RUST_FIXTURE_THEME: CommunityThemeDefinition = {
  id: 'preset-real-black-oled',
  name: 'Real Black OLED',
  author: 'Kodera Design System',
  baseMode: 'black',
  tokens: {
    '--c-page': 'rgb(0, 0, 0)',
    '--c-surface': 'rgb(11, 12, 14)',
    '--c-sunken': 'rgb(6, 6, 7)',
    '--c-action': 'rgb(67, 97, 238)',
    '--c-ink': 'rgb(241, 244, 248)',
  },
}

function base64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The Rust tests' `code(raw)`: any JSON text wrapped as a share code. */
function code(raw: string): string {
  return `${THEME_SHARE_PREFIX}${base64(raw)}`
}

function refusal(raw: string): ThemeRefusal | 'accepted' {
  const result = decodeShareableTheme(raw)
  return result.ok ? 'accepted' : result.reason
}

describe('theme share codes match the Rust codec', () => {
  it('encodes the Rust canonical fixture byte for byte and round-trips it', () => {
    const encoded = encodeShareableTheme(RUST_FIXTURE_THEME)
    expect(encoded).toEqual({ ok: true, code: code(RUST_FIXTURE_JSON) })
    expect(decodeShareableTheme(code(RUST_FIXTURE_JSON))).toEqual({
      ok: true,
      theme: RUST_FIXTURE_THEME,
    })
  })

  it('round-trips the bounds the Rust test accepts: 32 × « é », a backslash, a 64-char id', () => {
    const theme = {
      ...RUST_FIXTURE_THEME,
      name: 'é'.repeat(32),
      author: 'A \\',
      id: 'a'.repeat(64),
    }
    const encoded = encodeShareableTheme(theme)
    expect(encoded.ok).toBe(true)
    if (encoded.ok) expect(decodeShareableTheme(encoded.code)).toEqual({ ok: true, theme })
  })

  it('accepts a surrogate pair escape and whitespace between tokens, like Rust', () => {
    const pair = RUST_FIXTURE_JSON.replace('Real Black OLED', '\\ud83e\\udded')
    const result = decodeShareableTheme(code(pair))
    expect(result.ok && result.theme.name).toBe('🧭')
    const spaced = RUST_FIXTURE_JSON.replace('{"v":1,', '{ "v" : 1 ,\n')
    expect(refusal(code(spaced))).toBe('accepted')
  })

  // Every vector of `theme_json_rejects_unknown_duplicate_nested_and_wrong_types`.
  it.each<[string, ThemeRefusal]>([
    [RUST_FIXTURE_JSON.replace('"v":1', '"v":1,"v":1'), 'duplicate-field'],
    [RUST_FIXTURE_JSON.replace('"v":1', '"v":1,"\\u0076":1'), 'duplicate-field'],
    [RUST_FIXTURE_JSON.replace('"v":1', '"v":1,"other":"x"'), 'unknown-field'],
    [RUST_FIXTURE_JSON.replace('"v":1', '"v":1.0'), 'version'],
    [RUST_FIXTURE_JSON.replace('"v":1', '"v":true'), 'version'],
    [RUST_FIXTURE_JSON.replace('"v":1', '"v":2'), 'version'],
    [RUST_FIXTURE_JSON.replace('"id":', '"identity":'), 'unknown-field'],
    [RUST_FIXTURE_JSON.replace('"tokens":{', '"tokens":{"nested":{},'), 'unknown-field'],
    [RUST_FIXTURE_JSON.replace('"--c-page":', '"other":'), 'unknown-field'],
    [
      RUST_FIXTURE_JSON.replace('"--c-page":', '"--c-page":"rgb(0, 0, 0)","--c-page":'),
      'duplicate-field',
    ],
    [`${RUST_FIXTURE_JSON} garbage`, 'json'],
    [RUST_FIXTURE_JSON.replace('"author":"Kodera Design System",', ''), 'missing-field'],
    [RUST_FIXTURE_JSON.replace('"name":"Real Black OLED"', '"name":"\\ud800"'), 'json'],
  ])('refuses JSON vector %#', (raw, reason) => {
    expect(refusal(code(raw))).toBe(reason)
  })

  // Every vector of `theme_rgb_refuses_css_and_noncanonical_channels`.
  it.each([
    'rgb(256, 0, 0)',
    'rgb(-1, 0, 0)',
    'rgb(00, 0, 0)',
    'rgb(0,0,0)',
    'rgba(0, 0, 0, 1)',
    // A CSS hex colour, spelt in two parts so the inline-colour guard does not read test data as a colour.
    '#'.concat('000000'),
    'var(--c-page)',
    'rgb(0, 0, 0);url(x)',
  ])('refuses the colour %s', (value) => {
    expect(refusal(code(RUST_FIXTURE_JSON.replace('rgb(0, 0, 0)', value)))).toBe('colour')
  })

  // `theme_metadata_bounds_use_utf8_and_no_sanitizing`, through the decoder.
  it.each(['', ' name', 'name ', 'a\\n', 'a\\u200b', 'a\\u2028', 'a\\u2029', 'é'.repeat(33)])(
    'refuses the name and the author %j',
    (bad) => {
      expect(refusal(code(RUST_FIXTURE_JSON.replace('Real Black OLED', bad)))).toBe('name')
      expect(refusal(code(RUST_FIXTURE_JSON.replace('Kodera Design System', bad)))).toBe('author')
    }
  )

  it.each(['UPPER', 'a_b', 'a.b', 'a'.repeat(65)])('refuses the id %s', (id) => {
    expect(refusal(code(RUST_FIXTURE_JSON.replace('preset-real-black-oled', id)))).toBe('id')
  })

  it('refuses an empty id as an id', () => {
    expect(refusal(code(RUST_FIXTURE_JSON.replace('preset-real-black-oled', '')))).toBe('id')
  })

  // `valid_unicode_surrogate_pair_decodes_and_controls_do_not`.
  it.each([
    ['\\n', 'name'],
    ['\\u0000', 'name'],
    ['\\u202e', 'name'],
    ['\\udc00', 'json'],
    ['\\ud800x', 'json'],
  ] as const)('refuses the escaped name %s', (replacement, reason) => {
    expect(refusal(code(RUST_FIXTURE_JSON.replace('Real Black OLED', replacement)))).toBe(reason)
  })

  // `theme_base64_requires_standard_canonical_padding_and_bound_before_trim`.
  it.each(['Zg', 'Zh==', 'Zm9=', 'Zg==Zg==', 'Zg=', 'Zg===', 'Zg==\n', 'Zg--', 'Zg__', '=g=='])(
    'refuses the non-canonical base64 %j',
    (payload) => {
      expect(refusal(`${THEME_SHARE_PREFIX}${payload}`)).toBe('base64')
    }
  )

  it('refuses an empty payload as base64', () => {
    expect(refusal(THEME_SHARE_PREFIX)).toBe('base64')
  })

  it('never trims: a leading or trailing space is refused', () => {
    const valid = code(RUST_FIXTURE_JSON)
    expect(refusal(` ${valid}`)).toBe('prefix')
    expect(refusal(`${valid} `)).toBe('base64')
  })

  // `theme_wire_bound_is_applied_to_the_whole_untrimmed_code`.
  it('applies the 2048-byte bound to the whole code, before anything else', () => {
    const padded = RUST_FIXTURE_JSON + ' '.repeat(1524 - RUST_FIXTURE_JSON.length)
    const valid = code(padded)
    expect(valid.length).toBe(MAX_THEME_SHARE_CODE_BYTES)
    expect(refusal(valid)).toBe('accepted')
    expect(refusal(`${valid} `)).toBe('too-long')
    expect(refusal(`${THEME_SHARE_PREFIX}${'A'.repeat(2048)}`)).toBe('too-long')
    // Bytes, not UTF-16 units: 1100 « é » are 2200 bytes.
    expect(refusal('é'.repeat(1100))).toBe('too-long')
  })
})

describe('each refusal reason, one by one', () => {
  it.each<[string, string, ThemeRefusal]>([
    ['the prefix', 'kodera-theme:v2:e30=', 'prefix'],
    ['invalid UTF-8', `${THEME_SHARE_PREFIX}/w==`, 'utf8'],
    ['a byte-order mark', code(String.fromCharCode(0xfeff) + RUST_FIXTURE_JSON), 'json'],
    ['a JSON array', code('[]'), 'field-type'],
    ['a version missing', code(RUST_FIXTURE_JSON.replace('"v":1,', '')), 'missing-field'],
    ['a version string', code(RUST_FIXTURE_JSON.replace('"v":1', '"v":"1"')), 'version'],
    ['a name number', code(RUST_FIXTURE_JSON.replace('"Real Black OLED"', '42')), 'field-type'],
    [
      'tokens as a string',
      code(RUST_FIXTURE_JSON.replace(/"tokens":\{.*\}\}$/, '"tokens":"x"}')),
      'field-type',
    ],
    [
      'a token missing',
      code(RUST_FIXTURE_JSON.replace(',"--c-sunken":"rgb(6, 6, 7)"', '')),
      'missing-field',
    ],
    ['an unknown base mode', code(RUST_FIXTURE_JSON.replace('"black"', '"oled"')), 'base-mode'],
    ['a capitalised base mode', code(RUST_FIXTURE_JSON.replace('"black"', '"Black"')), 'base-mode'],
  ])('refuses %s', (_label, raw, reason) => {
    expect(refusal(raw)).toBe(reason)
  })

  it('refuses to encode what it would refuse to decode', () => {
    expect(encodeShareableTheme({ ...RUST_FIXTURE_THEME, id: 'Bad Id' })).toEqual({
      ok: false,
      reason: 'id',
    })
    expect(
      encodeShareableTheme({
        ...RUST_FIXTURE_THEME,
        tokens: { ...RUST_FIXTURE_THEME.tokens, '--c-ink': 'red' },
      })
    ).toEqual({ ok: false, reason: 'colour' })
    expect(encodeShareableTheme({ ...RUST_FIXTURE_THEME, name: 'x\u0000' })).toEqual({
      ok: false,
      reason: 'name',
    })
  })
})

describe('themes read back from local storage', () => {
  it('keeps valid entries and drops every invalid one instead of applying it', () => {
    const valid = { ...RUST_FIXTURE_THEME }
    const stored = JSON.stringify([
      valid,
      { ...valid, id: 'with-extra', extra: true },
      { ...valid, id: 'bad-colour', tokens: { ...valid.tokens, '--c-page': 'url(x)' } },
      { ...valid, id: 'bad-mode', baseMode: 'sepia' },
      { ...valid, id: 'missing-token', tokens: { '--c-page': 'rgb(0, 0, 0)' } },
      { ...valid, id: 'UPPER' },
      'not an object',
      null,
    ])
    expect(parseStoredThemes(stored)).toEqual([valid])
  })

  it('reads anything unreadable as an empty library', () => {
    expect(parseStoredThemes(null)).toEqual([])
    expect(parseStoredThemes('{not json')).toEqual([])
    expect(parseStoredThemes('{"id":"x"}')).toEqual([])
  })
})

describe('theme ids derived from a free-text name', () => {
  it('stay inside the id rule', () => {
    expect(themeIdFromName('Mon Thème Souverain')).toBe('custom-mon-theme-souverain')
    expect(themeIdFromName('   ')).toBe('custom-theme')
    const long = themeIdFromName('a '.repeat(80))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^[a-z0-9-]+$/)
  })
})
