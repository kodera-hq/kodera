// Owner ruling (2026-09-23): one support address, kept in one constant. This
// fails on an address of ours spelled anywhere else a customer can read it —
// product code, the generated catalogues, the catalogue sources, the HTML
// shell and the public assets — so a second address cannot drift in beside
// `SUPPORT_EMAIL`.
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUPPORT_EMAIL } from './supportContact'

const ROOT = join(__dirname, '..', '..')
/** Any mailbox on one of our domains, in any letter case. */
const OUR_ADDRESS = /[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*(?:samourai|kodera)\.[a-z]+/gi
const TEXT = new Set([
  '.ts',
  '.tsx',
  '.json',
  '.css',
  '.md',
  '.html',
  '.svg',
  '.webmanifest',
  '.txt',
  '.xml',
])

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

function scanned(path: string): boolean {
  const rel = relative(ROOT, path)
  if (rel.startsWith('src/mocks/') || rel.startsWith('src/api/')) return false
  if (/\.(test|stories)\.tsx?$/.test(rel)) return false
  if (rel === 'src/app/supportContact.ts') return false
  return TEXT.has(extname(rel))
}

const SOURCES = [
  ...files(join(ROOT, 'src')),
  ...files(join(ROOT, 'public')),
  join(ROOT, 'index.html'),
  join(ROOT, 'docs/specs/copy/fr.md'),
  join(ROOT, 'docs/specs/copy/en.md'),
].filter(scanned)

describe('the support address', () => {
  it('is named in one place only', () => {
    const found = SOURCES.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(OUR_ADDRESS)].map(
        (match) => `${relative(ROOT, path)}: ${match[0]}`
      )
    )
    expect(found).toEqual([])
    expect(SUPPORT_EMAIL).toBe('support@kodera.io')
  })

  // The guard's own proof: a pattern that could not see the address it
  // protects, or a scan that read almost nothing, would pass vacuously.
  it('is seen by the pattern the guard uses, in any case', () => {
    expect(SUPPORT_EMAIL.match(OUR_ADDRESS)).toEqual([SUPPORT_EMAIL])
    expect('Écrivez à Support@Samourai.APP'.match(OUR_ADDRESS)).toEqual(['Support@Samourai.APP'])
  })

  it('is looked for across the whole customer surface', () => {
    const rel = SOURCES.map((path) => relative(ROOT, path))
    expect(rel.length).toBeGreaterThanOrEqual(150)
    expect(rel).toContain('index.html')
    expect(rel).toContain('public/site.webmanifest')
    expect(rel).toContain('src/i18n/fr.json')
    expect(rel).toContain('docs/specs/copy/fr.md')
  })
})
