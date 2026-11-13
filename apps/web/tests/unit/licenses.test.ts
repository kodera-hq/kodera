import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
const SCRIPT_PATH = join(REPO_ROOT, 'scripts/ci/check-licenses.py')
const LOCK_PATH = join(REPO_ROOT, 'package-lock.json')

function runLicenseCheck(args: readonly string[]): {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
} {
  try {
    const stdout = execFileSync('python3', [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failed.status ?? 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    }
  }
}

describe('Apache-2.0 dependency licence gate (scripts/ci/check-licenses.py)', () => {
  it('passes its built-in mutation selftest (>= 12 acceptance and refusal cases)', () => {
    const result = runLicenseCheck(['--selftest'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/check-licenses selftest: \d+ cases passed/)
  })

  it('verifies the repository package-lock.json carries only acceptable permissive licences', () => {
    const result = runLicenseCheck(['--lock', LOCK_PATH])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/every licence accepted/)
  })

  it('refuses @blocknote/*, GPL/AGPL/LGPL/SSPL, compound AND copyleft, and undeclared entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kodera-license-test-'))
    try {
      const lockFile = join(dir, 'package-lock.json')
      writeFileSync(
        lockFile,
        JSON.stringify({
          packages: {
            '': { name: 'fixture-root' },
            'node_modules/@blocknote/core': { license: 'MIT' },
            'node_modules/copyleft-pkg': { license: '(MIT OR GPL-3.0-only) AND AGPL-3.0-only' },
            'node_modules/missing-lic': { version: '1.0.0' },
          },
        }),
        'utf-8'
      )
      const result = runLicenseCheck(['--lock', lockFile])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('forbidden scope `@blocknote`')
      expect(result.stderr).toContain('is refused')
      expect(result.stderr).toContain('no licence declared')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
