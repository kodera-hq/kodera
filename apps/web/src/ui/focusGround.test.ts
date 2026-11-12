import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { FOCUS_GROUND_ELEVATED } from './focusGround'

const css = readFileSync(
  createRequire(import.meta.url).resolve('@kodera/design-tokens/tokens.css'),
  'utf8'
)

describe('FOCUS_GROUND_ELEVATED', () => {
  it('sets the focus ground to a custom property every theme declares', () => {
    const match = /^\[--focus-ring-ground:var\((--c-[a-z0-9-]+)\)\]$/.exec(FOCUS_GROUND_ELEVATED)
    expect(match, 'the class must set --focus-ring-ground from one var()').not.toBeNull()
    const property = match?.[1] ?? ''
    for (const theme of ['light', 'dark', 'black']) {
      const selector = `[data-theme="${theme}"]`
      const block = css.slice(css.indexOf(`${selector} {`))
      const body = block.slice(0, block.indexOf('}'))
      expect(body, `${property} is declared in the ${theme} theme block`).toContain(
        `  ${property}: `
      )
    }
  })
})
