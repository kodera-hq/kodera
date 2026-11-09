import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { sourceFiles } from '@kodera/design-tokens/token-test'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// `c-action` is the mock's link and edge colour. It was 2.88 : 1 against
// `c-surface` in dark and 3.36 : 1 in black when the owner approved
// `c-accent-ink` for chosen edges; tokens v0.5.0 make it 3.54 and 3.90, still
// under 4.5 : 1 for text, and the edge ruling stands until the owner revisits it. Ordinary link/action text now uses theme ink. This file holds two things:
// the ratios the replacement roles reach, read from the pinned tokens in all
// three themes, and a walk that refuses `c-action` as text or as an edge
// anywhere under `src/` outside the entries below.

const SRC = join(import.meta.dirname, '..', '..', '..', 'src')
const TOKENS_CSS = createRequire(import.meta.url).resolve('@kodera/design-tokens/tokens.css')
const THEMES = {
  light: ':root, [data-theme="light"] {',
  dark: '[data-theme="dark"] {',
  black: '[data-theme="black"] {',
} as const
type Theme = keyof typeof THEMES

function roles(theme: Theme): Map<string, string> {
  const css = readFileSync(TOKENS_CSS, 'utf8')
  const start = css.indexOf(THEMES[theme])
  if (start === -1) throw new Error(`no ${theme} block in tokens.css`)
  const block = css.slice(start, css.indexOf('}', start))
  const found = new Map<string, string>()
  for (const [, name = '', value = ''] of block.matchAll(/--c-([\w-]+):\s*([^;]+);/g))
    found.set(name, value.trim())
  // The page ground is a gradient; each of its stops is a ground of its own.
  const stops = found.get('page-grad')?.match(/#[0-9a-f]{6}/gi) ?? []
  stops.forEach((stop, index) => found.set(`page-grad-${index}`, stop))
  return found
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

const GROUNDS = ['surface', 'muted', 'sunken', 'page-grad-0', 'page-grad-1', 'page-grad-2']

// [where, foreground role, the grounds it sits on, minimum]
const PAIRS: ReadonlyArray<readonly [string, string, readonly string[], number]> = [
  ['ordinary link text: tertiary Button/LinkButton and DocumentViewer', 'ink', GROUNDS, 4.5],
  ['Breadcrumb hover', 'accent-ink', GROUNDS, 4.5],
  ['ProgressList running caption', 'accent-ink', ['surface'], 4.5],
  ['Tabs active label and underline', 'accent-ink', GROUNDS, 4.5],
  [
    'Checkbox and RadioGroup checked edge, RadioGroup dot',
    'accent-ink',
    ['surface', 'accent-soft'],
    3,
  ],
  [
    'field focus edge, FileDrop hover and drag edge',
    'accent-ink',
    ['surface', 'accent-soft', ...GROUNDS],
    3,
  ],
  ['ProgressList running ring and spinner', 'accent-ink', ['surface'], 3],
  ['Checkbox glyph on its action fill', 'on-inverse', ['action'], 3],
  ['Sidebar current item text', 'accent-ink', ['surface'], 4.5],
  ['Sidebar idle item text', 'ink-2', GROUNDS, 4.5],
  ['module rail current glyph on its action tile', 'on-inverse', ['action'], 4.5],
]

describe('the roles that replace action as text and edge', () => {
  for (const theme of Object.keys(THEMES) as Theme[]) {
    it(`clear their minimum on every ground in ${theme}`, () => {
      const values = roles(theme)
      const short: string[] = []
      for (const [where, foreground, grounds, minimum] of PAIRS) {
        for (const ground of grounds) {
          const fg = values.get(foreground)
          const bg = values.get(ground)
          if (fg === undefined || bg === undefined) {
            short.push(`${where}: ${foreground} on ${ground} has no ${theme} value`)
            continue
          }
          const measured = ratio(fg, bg)
          if (measured < minimum)
            short.push(`${where}: ${foreground} on ${ground} ${measured.toFixed(2)} < ${minimum}`)
        }
      }
      expect(short).toEqual([])
    })
  }

  it('measures action on the dark surface as the failure it is', () => {
    // The ratio this change exists for: under 4.5 : 1 as text. If the tokens
    // move it again, this fails and the entries below can be reconsidered.
    const dark = roles('dark')
    expect(ratio(dark.get('action') ?? '', dark.get('surface') ?? '')).toBeCloseTo(3.54, 2)
  })
})

// `c-action` as text, or as an edge or indicator drawn on a ground, under any
// variant prefix: text, decoration, caret, border (any side), divide, ring,
// ring-offset, outline, shadow, SVG fill and stroke, and the native control
// accent. A `bg-` fill is not judged: `action` as a fill (the primary button,
// `Switch`, `Gauge`, `Stepper`) carries its own `on-inverse` content and is
// listed in the pull request as a separate follow-up.
const ACTION_AS_TEXT_OR_EDGE =
  /(?<![\w-])(?:[\w[\]=&-]+:)*(?:text|decoration|caret|border(?:-[trblxyse])?|divide|ring|ring-offset|outline|shadow|fill|stroke|accent)-c-action(?:-hover)?(?![\w-])/g

// Kept on `action` by owner ruling (2026-09-24):
const OWNER_RULED = new Set([
  // PlanCard's recommended edge: its "Recommandé" pill carries the meaning,
  // and `c-accent-ink` is already the chosen edge.
  'ui/Card/Card.tsx border-c-action',
  // The info banner's left stripe, beside its own text and border.
  'ui/Banner/Banner.tsx border-l-c-action',
])

describe('action as text or edge under src/', () => {
  it('appears only where the owner ruled it stays', () => {
    const files = sourceFiles(SRC).filter((path) => !/\.(?:test|stories)\.tsx?$/.test(path))
    const found = new Set<string>()
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      for (const [className] of source.matchAll(ACTION_AS_TEXT_OR_EDGE))
        found.add(`${relative(SRC, path).split('\\').join('/')} ${className}`)
    }
    expect([...found].filter((entry) => !OWNER_RULED.has(entry))).toEqual([])
    expect([...OWNER_RULED].filter((entry) => !found.has(entry))).toEqual([])
    // Floor: 297 files measured without tests and stories, set at about 80%.
    expect(files.length).toBeGreaterThan(237)
  })

  it('recognises every shape it refuses', () => {
    const shapes = [
      'text-c-action',
      'hover:text-c-action-hover',
      'data-[state=active]:border-c-action',
      'focus-within:border-c-action',
      'border-l-c-action',
      'ring-c-action',
      'group-hover:outline-c-action',
      'fill-c-action',
      'stroke-c-action',
      'divide-c-action',
      'border-s-c-action',
      'border-e-c-action',
      'shadow-c-action',
      'caret-c-action',
      'accent-c-action',
      'ring-offset-c-action',
      'decoration-c-action-hover',
    ]
    for (const shape of shapes)
      expect(
        [...`className="x ${shape} y"`.matchAll(ACTION_AS_TEXT_OR_EDGE)].map(([m]) => m)
      ).toEqual([shape])
    expect([
      ...'className="bg-c-action hover:bg-c-action-hover text-c-accent-ink var(--c-action)"'.matchAll(
        ACTION_AS_TEXT_OR_EDGE
      ),
    ]).toEqual([])
  })
})

// A link inside running text is underlined at rest; every other link and
// tertiary button underlines on hover (owner ruling, 2026-09-24). The at-rest
// `underline` class lives in two places only, so a new one has to go through
// `LINK_TEXT.inline` (`LinkButton inline`).
const AT_REST_UNDERLINE_ALLOWED = new Set(['ui/linkText.ts', 'ui/LinkButton/LinkButton.tsx'])

function stringsIn(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    if (ts.isTemplateExpression(node)) {
      out.push(node.head.text)
      for (const span of node.templateSpans) out.push(span.literal.text)
    }
    if (ts.isJsxText(node)) return
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

describe('at-rest link underline', () => {
  it('is written only by LINK_TEXT.inline and LinkButton', () => {
    const files = sourceFiles(SRC).filter((path) => !/\.(?:test|stories)\.tsx?$/.test(path))
    const found = files
      .filter((path) => stringsIn(path).some((text) => text.split(/\s+/).includes('underline')))
      .map((path) => relative(SRC, path).split('\\').join('/'))
    expect(found.filter((entry) => !AT_REST_UNDERLINE_ALLOWED.has(entry))).toEqual([])
    expect([...AT_REST_UNDERLINE_ALLOWED].filter((entry) => !found.includes(entry))).toEqual([])
  })
})
