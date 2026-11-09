// scripts/precompress.mjs against a real temporary build tree, and its place in `npm run build`
// (docs/specs/asset-caching-and-compression.md).
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a Node script with no type declarations, imported for its one export.
import { precompress } from '../../../scripts/precompress.mjs'

const LARGE = 'export const value = "' + 'kodera '.repeat(2000) + '"\n'

describe('precompress', () => {
  let dist = ''
  beforeEach(async () => {
    dist = join(await mkdtemp(join(tmpdir(), 'console-precompress-')), 'dist')
    await mkdir(join(dist, 'assets'), { recursive: true })
    await writeFile(join(dist, 'index.html'), '<!doctype html>' + 'x'.repeat(4096))
    await writeFile(join(dist, 'assets', 'main-abc.js'), LARGE)
    await writeFile(join(dist, 'assets', 'small-abc.js'), 'export {}\n')
    await writeFile(join(dist, 'assets', 'font-abc.woff2'), Buffer.alloc(4096, 7))
  })
  afterEach(async () => {
    await rm(resolve(dist, '..'), { recursive: true, force: true })
  })

  it('writes a brotli and a gzip copy beside each large text asset, and nothing else', async () => {
    await precompress(dist)
    expect((await readdir(join(dist, 'assets'))).sort()).toEqual([
      'font-abc.woff2',
      'main-abc.js',
      'main-abc.js.br',
      'main-abc.js.gz',
      'small-abc.js',
    ])
    // The document is outside `assets`: never compressed, never cached.
    expect(await readdir(dist)).toEqual(['assets', 'index.html'])
    const br = await readFile(join(dist, 'assets', 'main-abc.js.br'))
    const gz = await readFile(join(dist, 'assets', 'main-abc.js.gz'))
    expect(brotliDecompressSync(br).toString()).toBe(LARGE)
    expect(gunzipSync(gz).toString()).toBe(LARGE)
    expect(br.length).toBeLessThan(LARGE.length)
  })

  it('skips only for an explicit preview flag, including the CLI', async () => {
    const script = resolve('scripts/precompress.mjs')
    const env = { ...process.env, KODERA_SKIP_PRECOMPRESS: '1' }
    expect(() => execFileSync(process.execPath, [script, dist], { env })).not.toThrow()
    expect((await readdir(join(dist, 'assets'))).sort()).toEqual([
      'font-abc.woff2',
      'main-abc.js',
      'small-abc.js',
    ])
    execFileSync(process.execPath, [script, dist], {
      env: { ...process.env, KODERA_SKIP_PRECOMPRESS: '0' },
    })
    expect(await readdir(join(dist, 'assets'))).toContain('main-abc.js.br')
  })

  it('refuses to run twice over one build, or over a tree with no assets', async () => {
    await precompress(dist)
    await expect(precompress(dist)).rejects.toThrow(/already compressed/)
    await expect(precompress(join(dist, 'assets'))).rejects.toThrow()
  })
})

describe('the build', () => {
  // staging builds with `npm run build` in a checkout (deployment profiles's core_release), and the
  // image with the same command, so the copies come from the build itself, never from one caller.
  it('compresses as the last step of `npm run build`, after the bundle is written', async () => {
    const { scripts } = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
    const steps = (scripts.build ?? '').split('&&').map((step) => step.trim())
    expect(steps.at(-1)).toBe('node scripts/precompress.mjs dist')
    expect(steps.indexOf('vite build')).toBe(steps.length - 2)
  })

  it('leaves the image to scan that build, and never compresses a second time', async () => {
    const dockerfile = await readFile('Dockerfile', 'utf8')
    const build = dockerfile.indexOf('npm run build')
    expect(build).toBeGreaterThan(-1)
    expect(dockerfile.indexOf('scripts/check-production-bundle.sh')).toBeGreaterThan(build)
    expect(dockerfile).not.toContain('precompress')
  })
})
