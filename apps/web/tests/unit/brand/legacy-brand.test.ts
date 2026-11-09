import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CATALOGUES,
  LEGAL_ENTITY_PHRASES,
  brandSurface,
  compressedTextChunks,
  findLegacyBrand,
  fold,
  isRowOf,
} from './legacy-brand'

// UX audit OL-14: a customer who arrives from kodera.io used to land on a tab
// named « samourai.app » and install an app named « Samouraï ». The product is
// Kodera; this guard keeps the previous name off every surface a customer reads
// before a screen renders, and out of the copy catalogues.

const ROOT = join(import.meta.dirname, '..', '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const SURFACE = brandSurface(ROOT)

/**
 * The guard's one assertion. The occurrences go in the failure message itself,
 * not only in the diff, so a red run names the file, the line and the needle.
 */
function expectNoLegacyBrand(found: string[]) {
  expect(
    found,
    `the previous product name is on a customer surface — write « Kodera » (only a legal-entity phrase may stay):\n${found.join('\n')}\n`
  ).toEqual([])
}

describe('the product name on customer surfaces', () => {
  it('is never the previous one: no samourai.app, no product-brand Samouraï', () => {
    expectNoLegacyBrand(findLegacyBrand(ROOT, SURFACE))
  })

  it('is Kodera in the tab title, before and after the catalogue boots', () => {
    // index.html's <title> is what the tab shows until `main.tsx` sets
    // `document.title` from the catalogue; both must say the same thing.
    expect(/<title>([^<]*)<\/title>/.exec(read('index.html'))?.[1]).toBe('Kodera')
    for (const locale of ['fr', 'en']) {
      const catalogue = JSON.parse(read(`src/i18n/${locale}.json`)) as Record<string, string>
      expect(catalogue['console.common.app-title'], locale).toBe('Kodera')
      // The login wordmark's name: its own key, so a per-screen title never renames the product.
      expect(catalogue['console.common.product-name'], locale).toBe('Kodera')
    }
  })

  it('names the product on the login screen from its own key, not the tab title', () => {
    // A per-screen tab title must never rename the product above the login card.
    const login = read('src/features/login/LoginScreen.tsx')
    expect(login).toContain("{t('console.common.product-name')}")
    expect(login).not.toContain("t('console.common.app-title')")
  })

  it('is Kodera when the console is installed as an app', () => {
    const manifest = JSON.parse(read('public/site.webmanifest')) as Record<string, unknown>
    expect(manifest.name).toBe('Kodera')
    expect(manifest.short_name).toBe('Kodera')
  })

  it('draws the favicon from the Kodera monogram and names it Kodera', () => {
    const paths = (source: string) => [...source.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1])
    const mark = paths(read('src/ui/icons/KoderaMark.tsx'))
    expect(mark).toHaveLength(7)
    const favicon = read('public/favicon.svg')
    expect(paths(favicon)).toEqual(mark)
    expect(favicon).toContain('aria-label="Kodera"')
  })

  it('carries no compressed text chunk in any PNG on the surface, which the scan could not read', () => {
    expect(compressedTextChunks(ROOT, SURFACE)).toEqual([])
  })
})

describe('the legacy-brand guard itself', () => {
  let scratch: string | undefined
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  /** A copy of the whole surface, so a mutation never touches the tree. */
  function copyOfSurface(): string {
    scratch = mkdtempSync(join(tmpdir(), 'legacy-brand-'))
    for (const file of SURFACE) {
      cpSync(join(ROOT, file), join(scratch, file), { recursive: true })
    }
    return scratch
  }

  function mutate(root: string, file: string, edit: (text: string) => string) {
    const path = join(root, file)
    const before = readFileSync(path, 'utf8')
    const after = edit(before)
    // A mutation that changed nothing would make every assertion below vacuous.
    expect(after).not.toBe(before)
    writeFileSync(path, after)
  }

  it('reads the whole surface: exactly the named files, and every file under public/', () => {
    // The named files, exactly: dropping one (a refactor, a rename) must fail here.
    expect(SURFACE.filter((file) => !file.startsWith('public/'))).toEqual([
      'index.html',
      'docs/specs/copy/fr.md',
      'docs/specs/copy/en.md',
      'src/i18n/fr.json',
      'src/i18n/en.json',
      'src/features/login/LoginScreen.tsx',
      'src/features/security/mock/MfaEnrolSimulation.tsx',
      'src/features/security/mock/totp.ts',
    ])
    // public/, against a listing the guard's own walk does not produce: 14
    // files today (the README, the manifest, four SVGs, seven PNGs, the .ico).
    const listed = readdirSync(join(ROOT, 'public'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
      .sort()
    expect(listed.length).toBeGreaterThanOrEqual(14)
    expect(listed).toContain('public/icon-16.png')
    expect(listed).toContain('public/favicon.ico')
    expect(SURFACE.filter((file) => file.startsWith('public/'))).toEqual(listed)
  })

  it('passes an unmutated copy and fails one with samourai.app in index.html, naming the file and the needle', () => {
    const root = copyOfSurface()
    expect(findLegacyBrand(root, SURFACE)).toEqual([])

    mutate(root, 'index.html', (text) =>
      text.replace(/<title>[^<]*<\/title>/, '<title>samourai.app</title>')
    )
    const found = findLegacyBrand(root, SURFACE)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/^index\.html:\d+: samourai\.app — <title>samourai\.app<\/title>$/)

    // The status half: the very assertion the guard runs must fail on it, and
    // its failure message must carry the file and the needle.
    expect(() => expectNoLegacyBrand(found)).toThrow(/index\.html:\d+: samourai\.app/)
  })

  it('fails a copy whose authenticator issuer or login wordmark is the old name again', () => {
    const root = copyOfSurface()
    mutate(root, 'src/features/security/mock/MfaEnrolSimulation.tsx', (text) =>
      text.replace("accountEmail, 'Kodera')", "accountEmail, 'samourai.app')")
    )
    mutate(root, 'src/features/login/LoginScreen.tsx', (text) =>
      text.replace("{t('console.common.product-name')}", 'samourai.app')
    )
    mutate(root, 'src/features/security/mock/totp.ts', (text) =>
      text.replace('the entry reads "Kodera', 'the entry reads "samourai.app')
    )
    const found = findLegacyBrand(root, SURFACE).map((line) => line.split(' — ')[0])
    expect(found).toHaveLength(3)
    expect(found[0]).toMatch(/^src\/features\/login\/LoginScreen\.tsx:\d+: samourai\.app$/)
    expect(found[1]).toMatch(
      /^src\/features\/security\/mock\/MfaEnrolSimulation\.tsx:\d+: samourai\.app$/
    )
    expect(found[2]).toMatch(/^src\/features\/security\/mock\/totp\.ts:\d+: samourai\.app$/)
  })

  it('sees every spelling: accented, upper-case, decomposed, and inside a PNG text chunk', () => {
    const root = copyOfSurface()
    mutate(root, 'public/site.webmanifest', (text) =>
      text.replace(/"short_name": "[^"]*"/, '"short_name": "Samouraï"')
    )
    mutate(root, 'src/i18n/fr.json', (text) =>
      text.replace(/("console\.common\.app-title": )"[^"]*"/, '$1"CONSOLE SAMOURAÏ"')
    )
    // `i` + U+0308 COMBINING DIAERESIS: renders exactly like « ï ».
    mutate(root, 'docs/specs/copy/fr.md', (text) => `${text}\n| x | Équipe Samourai\u0308 |\n`)
    const png = join(root, 'public/icon-16.png')
    writeFileSync(
      png,
      Buffer.concat([readFileSync(png), Buffer.from('tEXtSoftware\0samourai.app\n')])
    )

    const found = findLegacyBrand(root, SURFACE)
    expect(found.map((line) => line.split(': ')[0]?.replace(/:\d+$/, ''))).toEqual([
      'public/icon-16.png',
      'public/site.webmanifest',
      'docs/specs/copy/fr.md',
      'src/i18n/fr.json',
    ])
    expect(found.map((line) => line.split(': ')[1]?.split(' — ')[0])).toEqual([
      'samourai.app',
      'Samourai',
      'Samourai',
      'SAMOURAI',
    ])
  })

  it('sees through escapes, entities, compatibility forms and invisible characters', () => {
    const root = copyOfSurface()
    // HTML entities, each on its own line: named, named accent other than the
    // diaeresis, legacy forms without their `;`, and an invisible soft hyphen.
    mutate(root, 'index.html', (text) =>
      text.replace(
        '    <title>',
        [
          '<meta name="application-name" content="Samoura&iuml;" />',
          '<meta name="apple-mobile-web-app-title" content="Samoura&iacute;" />',
          '<meta name="description" content="Samoura&iuml" />',
          '<meta name="author" content="Samoura&#239" />',
          '<meta name="generator" content="Samou&shy;rai" />',
          '<title>',
        ]
          .map((line) => `    ${line}`)
          .join('\n')
      )
    )
    // XML numeric references, decimal and hexadecimal, one SVG each.
    mutate(root, 'public/favicon.svg', (text) =>
      text.replace('</svg>', '<desc>Samoura&#239;</desc></svg>')
    )
    mutate(root, 'public/kodera-mark-slate.svg', (text) =>
      text.replace('</svg>', '<desc>Samoura&#xef;</desc></svg>')
    )
    // A base64 data: URI inlining a PNG whose tEXt chunk holds a Latin-1 « Samouraï ».
    const inlined = Buffer.concat([
      readFileSync(join(ROOT, 'public/icon-16.png')),
      Buffer.from('tEXtAuthor\0Samoura\xef', 'latin1'),
    ]).toString('base64')
    mutate(root, 'public/kodera-lockup-slate.svg', (text) =>
      text.replace('</svg>', `<image href="data:image/png;base64,${inlined}"/>\n</svg>`)
    )
    // A JS hexadecimal escape.
    mutate(root, 'src/features/security/mock/MfaEnrolSimulation.tsx', (text) =>
      text.replace("accountEmail, 'Kodera')", "accountEmail, 'Samoura\\xef')")
    )
    mutate(root, 'public/site.webmanifest', (text) =>
      text.replace('"name": "Kodera"', '"name": "Kodera", "description": "Samoura\\u00efe"')
    )
    mutate(root, 'src/i18n/en.json', (text) =>
      text.replace('"Kodera staff"', '"\uff33\uff41\uff4d\uff4f\uff55\uff52\uff41\uff49 staff"')
    )
    mutate(root, 'src/features/login/LoginScreen.tsx', (text) =>
      // A zero-width space inside the domain; a JS code-point escape for « ï ».
      text.replace("{t('console.common.product-name')}", "{'samou\u200brai.app'}{'Samoura\\u{ef}'}")
    )
    const found = findLegacyBrand(root, SURFACE).map((line) =>
      line.split(' — ')[0]?.replace(/:\d+:/, ':')
    )
    expect(found).toEqual([
      'index.html: Samourai',
      'index.html: Samourai',
      'index.html: Samourai',
      'index.html: Samourai',
      'index.html: Samourai',
      'public/favicon.svg: Samourai',
      'public/kodera-lockup-slate.svg: (data: URI) Samourai',
      'public/kodera-mark-slate.svg: Samourai',
      'public/site.webmanifest: Samourai',
      'src/i18n/en.json: Samourai',
      'src/features/login/LoginScreen.tsx: samourai.app',
      'src/features/login/LoginScreen.tsx: Samourai',
      'src/features/security/mock/MfaEnrolSimulation.tsx: Samourai',
    ])
  })

  it('reads a binary as Latin-1 too: « Samouraï » in a PNG tEXt chunk is the lone byte 0xEF', () => {
    const root = copyOfSurface()
    const png = join(root, 'public/icon-32.png')
    writeFileSync(
      png,
      Buffer.concat([readFileSync(png), Buffer.from('tEXtAuthor\0Samoura\xef\n', 'latin1')])
    )
    const found = findLegacyBrand(root, SURFACE)
    expect(found.map((line) => line.split(' — ')[0]?.replace(/:\d+:/, ':'))).toEqual([
      'public/icon-32.png: Samourai',
    ])
  })

  it('finds a compressed text chunk, which the scan could not read, and only a real chunk', () => {
    const root = copyOfSurface()
    /** `png` with one chunk inserted before its IEND; the CRC is not read, so it is zero. */
    const withChunk = (png: Buffer, type: string, data: string) => {
      const iend = png.length - 12
      const length = Buffer.alloc(4)
      length.writeUInt32BE(Buffer.byteLength(data, 'latin1'))
      return Buffer.concat([
        png.subarray(0, iend),
        length,
        Buffer.from(type + data, 'latin1'),
        Buffer.alloc(4),
        png.subarray(iend),
      ])
    }
    const insert = (file: string, type: string, data: string) => {
      const path = join(root, file)
      writeFileSync(path, withChunk(readFileSync(path), type, data))
    }
    insert('public/icon-16.png', 'zTXt', 'Author\0\0x\x9c')
    insert('public/icon-32.png', 'iTXt', 'Author\0\x01\0\0\0x\x9c')
    // An uncompressed iTXt is read as UTF-8 by the scan, so it is not reported here.
    insert('public/icon-48.png', 'iTXt', 'Author\0\0\0\0\0Kodera')
    // An .ico whose one 16 × 16 frame is a PNG carrying a zTXt chunk.
    const frame = withChunk(readFileSync(join(ROOT, 'public/icon-16.png')), 'zTXt', 'A\0\0x\x9c')
    const directory = Buffer.alloc(22)
    directory.writeUInt16LE(1, 2) // type: icon
    directory.writeUInt16LE(1, 4) // one frame
    directory.writeUInt8(16, 6)
    directory.writeUInt8(16, 7)
    directory.writeUInt16LE(1, 10)
    directory.writeUInt16LE(32, 12)
    directory.writeUInt32LE(frame.length, 14)
    directory.writeUInt32LE(22, 18) // the frame's offset
    writeFileSync(join(root, 'public/favicon.ico'), Buffer.concat([directory, frame]))
    // A note that merely spells the chunk types is no chunk.
    mutate(
      root,
      'public/README.md',
      (text) => `${text}\nNo icon here may carry a zTXt chunk or a compressed iTXt one.\n`
    )
    expect(compressedTextChunks(root, SURFACE)).toEqual([
      'public/favicon.ico',
      'public/icon-16.png',
      'public/icon-32.png',
    ])
  })

  it("lets the legal entity through on its own key's row, and nowhere else", () => {
    const root = copyOfSurface()
    // Its own row: the phrase is allowed, a domain beside it is not.
    mutate(
      root,
      'docs/specs/copy/en.md',
      (text) =>
        `${text.replace('Issued by Samouraï Coop through', 'Issued by Samouraï Coop, samourai.app, through')}\n| \`console.invoices.list.hint-issuer-note\` | Samouraï Coop |\n`
    )
    // Its own row, capitalised otherwise: not the registered name.
    mutate(root, 'src/i18n/en.json', (text) =>
      text.replace('"Issued by Samouraï Coop through', '"Issued by SAMOURAÏ COOP through')
    )
    // Its own row with a longer word: not the registered name. A sibling key
    // whose name starts with the bound one. The registered name on another
    // key's row: the product speaking.
    mutate(root, 'src/i18n/fr.json', (text) =>
      text
        .replace('"Émises par Samouraï Coop via', '"Émises par Samouraï Coopérative via')
        .replace(
          '  "console.invoices.list.hint-issuer": ',
          '  "console.invoices.list.hint-issuer-note": "Samouraï Coop",\n  "console.invoices.list.hint-issuer": '
        )
        .replace('"Personnel Kodera"', '"Personnel Samouraï Coop"')
    )
    // Its own row without « Coop »: the product's old name, not the entity's.
    // Then, not the registered name; the product's team; and prose that names
    // the key beside the phrase, as a Changelog line would.
    mutate(
      root,
      'docs/specs/copy/fr.md',
      (text) =>
        `${text.replace('Émises par Samouraï Coop via', 'Émises par Samouraï via')}\n| x | Samouraï Coopérative |\n| y | Équipe Samouraï |\n« Samouraï Coop » stays in \`console.invoices.list.hint-issuer\`.\n`
    )
    const found = findLegacyBrand(root, SURFACE).map((line) =>
      line.split(' — ')[0]?.replace(/:\d+:/, ':')
    )
    expect(found).toEqual([
      'docs/specs/copy/fr.md: Samourai',
      'docs/specs/copy/fr.md: Samourai',
      'docs/specs/copy/fr.md: Samourai',
      'docs/specs/copy/fr.md: Samourai',
      'docs/specs/copy/en.md: samourai.app',
      'docs/specs/copy/en.md: Samourai',
      'src/i18n/fr.json: Samourai',
      'src/i18n/fr.json: Samourai',
      'src/i18n/fr.json: Samourai',
      'src/i18n/en.json: SAMOURAI',
    ])
  })

  it('allows each phrase exactly where it is bound, and only while those rows still carry it', () => {
    // An allow-list entry nothing needs any more is a hole waiting for a
    // product-brand use to fall into it: delete it the day this fails. And a
    // key's row in every catalogue — two sources, two generated — is four.
    for (const { key, phrase, why } of LEGAL_ENTITY_PHRASES) {
      const rows = CATALOGUES.flatMap((file) =>
        read(file)
          .split('\n')
          .filter((line) => isRowOf(key, file, line) && fold(line).match(phrase) !== null)
          .map(() => file)
      )
      expect(rows, why).toEqual(CATALOGUES)
    }
  })
})
