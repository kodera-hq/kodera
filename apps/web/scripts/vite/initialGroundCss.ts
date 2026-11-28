import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

export function buildInitialGroundCss(): string {
  const tokensCss = readFileSync(
    createRequire(import.meta.url).resolve('@kodera/design-tokens/tokens.css'),
    'utf8'
  )
  const readToken = (name: string): string => {
    const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss)
    const value = match?.[1]?.trim()
    if (value === undefined || value === '') throw Error(`ENTRY_GROUND_TOKEN_MISSING: --${name}`)
    return value
  }
  const darkPage = readToken('theme-dark-page')
  const lightPage = readToken('theme-light-page')
  const rules = [
    `:root:not([data-theme]) body,[data-theme="dark"] body{background:${darkPage}}`,
    `@media(prefers-color-scheme:light){:root:not([data-theme]) body{background:${lightPage}}}`,
  ]
  for (const id of ['light', 'black', 'ciel', 'ciel-nuit']) {
    const page = readToken(`theme-${id}-page`)
    rules.push(`[data-theme="${id}"] body{background:${page}}`)
  }
  return `@layer theme{${rules.join('')}}`
}
