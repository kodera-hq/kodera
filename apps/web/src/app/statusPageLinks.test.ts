// Owner ruling 2026-09-24: the console links to no external status page. The
// Applications screen (`/{org}/status`) is the status source; whether a
// public status page exists, and at which address, is a later decision. This
// fails on any such link written into product code or the copy catalogues.
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
/** An external status host of ours, or a sentence sending the reader to one. */
const STATUS_PAGE =
  /https?:\/\/status\.[a-z0-9.-]+|page d['’]état publique|page de statut|public status page/gi

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

function scanned(rel: string): boolean {
  if (rel.startsWith('src/mocks/') || rel.startsWith('src/api/')) return false
  if (/\.(test|stories)\.tsx?$/.test(rel)) return false
  return ['.ts', '.tsx', '.json'].includes(extname(rel))
}

const SOURCES = [
  ...files(join(ROOT, 'src')).filter((path) => scanned(relative(ROOT, path))),
  join(ROOT, 'docs/specs/copy/fr.md'),
  join(ROOT, 'docs/specs/copy/en.md'),
]

describe('status', () => {
  it('is never sent to an external status page', () => {
    const found = SOURCES.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(STATUS_PAGE)].map(
        (match) => `${relative(ROOT, path)}: ${match[0]}`
      )
    )
    expect(found).toEqual([])
  })

  it('is looked for with a pattern that sees each shape, across the product code', () => {
    for (const sample of [
      'href="https://status.kodera.io"',
      '`https://status.kodera.io/${org}`',
      "Suivez-le sur notre page d'état publique.",
      'Public status page',
    ]) {
      expect(sample.match(STATUS_PAGE)).not.toBeNull()
    }
    expect(SOURCES.length).toBeGreaterThanOrEqual(150)
  })
})
