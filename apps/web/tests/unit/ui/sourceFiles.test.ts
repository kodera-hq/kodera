import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { sourceFiles } from '@kodera/design-tokens/token-test'
import { afterEach, describe, expect, it } from 'vitest'

// The token, spacing and theme-role guards judge the files the tokens package's
// `sourceFiles` lists under `src/`. Before v0.1.1 its default skipped a path when
// `/node_modules|dist|\.git/` matched anywhere in the absolute path, so
// `src/features/distribution/` and every file of a checkout under a `dist` or
// `.github` directory went unscanned without an error. These trees pin the
// whole-segment walk the console relies on, so a repin that loses it fails here.

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(files: string[], under = ''): { root: string; listed: () => string[] } {
  const base = mkdtempSync(join(tmpdir(), 'source-walk-'))
  roots.push(base)
  const root = join(base, under)
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return {
    root,
    listed: () =>
      sourceFiles(root)
        .map((path) => relative(root, path).split(sep).join('/'))
        .sort(),
  }
}

describe('the tokens package sourceFiles walk', () => {
  it('scans a directory whose name only contains a skipped name', () => {
    const { listed } = tree([
      'features/distribution/Card.tsx',
      'features/redistribute.ts',
      'app/.github-like/x.ts',
      'ui/Button.tsx',
    ])
    expect(listed()).toEqual([
      'app/.github-like/x.ts',
      'features/distribution/Card.tsx',
      'features/redistribute.ts',
      'ui/Button.tsx',
    ])
  })

  it('skips node_modules, dist and .git as whole segments', () => {
    const { listed } = tree([
      'node_modules/pkg/index.js',
      'features/dist/bundle.js',
      '.git/hooks/pre-commit.js',
      'ui/Button.tsx',
    ])
    expect(listed()).toEqual(['ui/Button.tsx'])
  })

  it('judges only the segments below the root, not the checkout around it', () => {
    const { listed } = tree(['features/Home.tsx'], join('dist', '.github', 'src'))
    expect(listed()).toEqual(['features/Home.tsx'])
  })
})
