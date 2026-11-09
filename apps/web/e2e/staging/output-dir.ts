// The run's temporary output directory (playwright.config.ts). Teardown removes it recursively,
// so only a directory this walk could have made is ever accepted: one directly under the system's
// temporary folder, named with the walk's prefix. A value set by hand to anything else is ignored.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const PREFIX = 'kodera-e2e-walk-'
export const OUTPUT_DIR_VARIABLE = 'KODERA_STAGING_OUTPUT_DIR'

export function isWalkOutputDir(dir: string | undefined): dir is string {
  if (!dir) return false
  const path = resolve(dir)
  return (
    path === dir &&
    dirname(path) === tmpdir() &&
    basename(path).startsWith(PREFIX) &&
    basename(path).length > PREFIX.length
  )
}

/** The directory the first read of the config made, which each worker inherits; else a new one. */
export function walkOutputDir(): string {
  const inherited = process.env[OUTPUT_DIR_VARIABLE]
  if (isWalkOutputDir(inherited)) return inherited
  const made = mkdtempSync(join(tmpdir(), PREFIX))
  process.env[OUTPUT_DIR_VARIABLE] = made
  return made
}
