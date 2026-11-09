// @vitest-environment node
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { build } from 'vite'
import production from '../../../vite.config'

it('emits a small real bundled font as a same-origin file under the production asset policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodera-font-build-'))
  try {
    await writeFile(
      join(root, 'index.html'),
      '<link rel="stylesheet" href="/font.css"><p>Font fixture</p>'
    )
    const input = createRequire(import.meta.url).resolve(
      '@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-cyrillic-ext-400-normal.woff2'
    )
    await copyFile(input, join(root, 'fixture.woff2'))
    await writeFile(
      join(root, 'font.css'),
      '@font-face{font-family:fixture;src:url(./fixture.woff2) format("woff2")}'
    )
    await mkdir(join(root, 'dist'))
    await build({
      configFile: false,
      root,
      publicDir: false,
      plugins: [],
      logLevel: 'silent',
      build: { ...production.build, outDir: join(root, 'dist'), emptyOutDir: true },
    })
    const files = await readdir(join(root, 'dist/assets'))
    const cssFiles = files.filter((name) => name.endsWith('.css'))
    expect(cssFiles).toHaveLength(1)
    const css = await readFile(join(root, 'dist/assets', cssFiles[0]!), 'utf8')
    expect(css, 'strict font-src self cannot load data fonts').not.toMatch(/url\(["']?data:/i)
    const fonts = files.filter((name) => name.endsWith('.woff2'))
    expect(fonts).toHaveLength(1)
    expect(await readFile(join(root, 'dist/assets', fonts[0]!))).toEqual(await readFile(input))
    expect(css).toContain(fonts[0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
