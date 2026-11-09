import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sourceFiles } from '@kodera/design-tokens/token-test'
import { describe, expect, it } from 'vitest'
import { COLOUR_FAMILIES } from './tailwind'

// Only the `c-*` roles follow `[data-theme]`; the preset's other colours are
// static ("Legacy colors remain static"), so they paint their light value in
// every theme, and so does Tailwind's default palette. This refuses, anywhere
// under `src/`: a static colour class on any colour utility, an arbitrary value
// carrying a colour, and a literal colour in an inline `style={{ … }}`. It also
// refuses an opacity modifier on a role (`bg-c-surface/40`). Under Tailwind 3
// that emitted no CSS rule at all, measured on the pinned preset: a `var()`
// colour has no channels to scale. Tailwind 4 compiles it to a `color-mix()`,
// so a class like it would start painting; allowing one is a design decision,
// made with the screens it moves, not a cleanup.

const SRC = join(import.meta.dirname, '..', '..', '..', 'src')
// Every colour family Tailwind emits for this repo's config: the preset's own
// (`c`, `ink`, `slate`, …) AND Tailwind's default palette the preset extends
// (`gray`, `zinc`, …), which compiles just as well. Only `c` follows the theme.
// `transparent`, `current` and `inherit` carry no colour value; they are how a
// class turns a colour off, as in `tests/unit/ui/tokens.test.ts`.
const KEYWORD_COLOURS = new Set(['transparent', 'current', 'inherit'])
const FAMILIES = new Set([...COLOUR_FAMILIES].filter((family) => !KEYWORD_COLOURS.has(family)))
// Every utility that takes a colour: accentColor, backgroundColor, borderColor,
// boxShadowColor, caretColor, divideColor, fill, gradientColorStops,
// outlineColor, placeholderColor, ringColor, ringOffsetColor, stroke, textColor,
// textDecorationColor, and the four Tailwind 4 added: `inset-shadow-*`,
// `inset-ring-*`, `text-shadow-*` and `drop-shadow-*`. Longest first, so
// `ring-offset-` is not read as `ring-` with a colour named `offset`.
const PREFIXES = [
  'inset-shadow',
  'inset-ring',
  'text-shadow',
  'drop-shadow',
  'bg',
  'text',
  'border',
  'ring-offset',
  'ring',
  'fill',
  'stroke',
  'divide',
  'outline',
  'shadow',
  'from',
  'via',
  'to',
  'placeholder',
  'caret',
  'accent',
  'decoration',
].sort((a, b) => b.length - a.length)
// The optional side (`border-l-`, `border-x-`, …) comes before the colour: without
// it, `border-l-red-500` reads as family `l` and a static colour walks past.
// Not after a word character or a hyphen: `var(--c-accent-ink)` holds the text
// `accent-ink`, which is a role reference, not the static class `accent-ink`.
const PREFIX = String.raw`(?<![\w-])(?:${PREFIXES.join('|')})-(?:[trblxyse]-)?`
const COLOUR_CLASS = new RegExp(String.raw`${PREFIX}([a-z][a-z0-9-]*)(\/\d+)?`, 'g')

// An arbitrary value on a colour utility is refused when the value carries a
// colour: a hex, a colour function, `theme(…)`, a CSS named colour anywhere in
// it (`bg-[red]`, `shadow-[0_0_0_1px_navy]`), or a variable that is not a
// `--c-*` role, written `var(--x)` or in Tailwind's `[--x]` shorthand. A type
// hint other than `color:` (`text-[length:…]`) says the value is not a colour.
// `text-[13px]`, `bg-[url(…)]` and `shadow-[0_0_0_1px_var(--c-border)]` pass.
const ARBITRARY_CLASS = new RegExp(String.raw`${PREFIX}\[([^\]\s]+)\]`, 'g')
const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|(?<![a-zA-Z-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color|theme)\(|var\(--(?!c-)/
// The 148 CSS named colours (CSS Color 4); `transparent` and `currentColor` are keywords.
const CSS_NAMED_COLOURS = new Set(
  `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
  crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
  darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
  dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
`
    .trim()
    .split(/\s+/)
)
function carriesColour(value: string): boolean {
  const hint = /^([a-z-]+):(?!\/)(.*)$/.exec(value)
  if (hint && hint[1] !== 'color') return false
  const rest = hint ? (hint[2] ?? '') : value
  if (/^--(?!c-)/.test(rest)) return true
  if (COLOUR_LITERAL.test(rest)) return true
  return rest
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((word) => CSS_NAMED_COLOURS.has(word))
}

// A colour in an inline `style={{ … }}` object literal, which no class scan sees.
// A colour property must be a `var(--c-*)` role or a keyword; a shorthand
// (`background`, `border`, `outline`, `boxShadow`, `textShadow`) must not carry
// a colour as `carriesColour` reads one. Only string literals written inside `style={{ … }}` are judged: a
// style object built elsewhere, or a value computed at run time, is not.
const STYLE_OBJECT = /style=\{\{([\s\S]*?)\}\}/g
const STYLE_COLOUR =
  /\b(color|backgroundColor|border(?:Top|Right|Bottom|Left|Block|Inline)?(?:Start|End)?Color|outlineColor|fill|stroke|textDecorationColor|caretColor|accentColor|background|border(?:Top|Right|Bottom|Left)?|outline|boxShadow|textShadow)\s*:\s*(['"`])([^'"`]*)\2/g
const ROLE_OR_KEYWORD = /^(?:var\(--c-[a-z0-9-]+\)|transparent|currentColor|inherit|none)$/
const SHORTHANDS = new Set([
  'background',
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'outline',
  'boxShadow',
  'textShadow',
])

/** No themed role exists for these yet: `c-ok-border` has no bad or warning
 * sibling (kodera-hq/kodera#5, item 3). Bound to the file,
 * and an entry that matches nothing fails, so an excuse cannot outlive its
 * reason. */
const NO_ROLE_YET = new Set([
  'ui/Banner/Banner.tsx border-red-500/40',
  'ui/Banner/Banner.tsx border-amber-500/40',
  'ui/Button/Button.tsx border-red-500/40',
  'ui/LinkButton/LinkButton.tsx border-red-500/40',
  'ui/Table/Table.tsx bg-red-100/60',
])

// Floors (docs/dev/TESTING.md §4): a walker that finds nothing, or a matcher that
// matches nothing, would pass every assertion below vacuously. Measured at 483
// files / 667 role classes over the whole of `src/`; set at roughly 80% of that.
// Raise when a wave adds files.
const MIN_FILES = 385
const MIN_ROLE_CLASSES = 533

interface Problem {
  className: string
  reason: string
}

function problems(source: string): Problem[] {
  const found: Problem[] = []
  for (const [className = '', key = '', alpha] of source.matchAll(COLOUR_CLASS)) {
    const family = key.split('-')[0] ?? ''
    if (!FAMILIES.has(family)) continue // text-center, shadow-card, divide-y …
    if (family !== 'c')
      found.push({ className, reason: 'a static colour, the same in every theme' })
    else if (alpha !== undefined) found.push({ className, reason: 'an opacity modifier on a role' })
  }
  for (const [className = '', value = ''] of source.matchAll(ARBITRARY_CLASS)) {
    if (carriesColour(value))
      found.push({ className, reason: 'an arbitrary colour, the same in every theme' })
  }
  for (const [, body = ''] of source.matchAll(STYLE_OBJECT)) {
    for (const [, property = '', , value = ''] of body.matchAll(STYLE_COLOUR)) {
      const coloured = SHORTHANDS.has(property)
        ? carriesColour(value)
        : !ROLE_OR_KEYWORD.test(value)
      if (coloured)
        found.push({
          className: `style ${property}: ${value}`,
          reason: 'an inline colour, the same in every theme',
        })
    }
  }
  return found
}

describe('theme roles', () => {
  it('refuses a static colour and an opacity modifier on a role, and nothing else', () => {
    expect(
      problems('<b className="bg-slate-100 hover:text-ink" />').map((p) => p.className)
    ).toEqual(['bg-slate-100', 'text-ink'])
    expect(problems('<b className="bg-c-surface/40" />')).toEqual([
      { className: 'bg-c-surface/40', reason: 'an opacity modifier on a role' },
    ])
    expect(problems('<b className="border-l-red-500 border-x-c-border/40" />')).toEqual([
      { className: 'border-l-red-500', reason: 'a static colour, the same in every theme' },
      { className: 'border-x-c-border/40', reason: 'an opacity modifier on a role' },
    ])
    expect(
      problems(
        '<b className="bg-c-surface text-c-ink-3 shadow-card shadow-c-shadow-1 border-2 border-t-2 border-b border-l-c-bad ring text-center text-sm divide-y data-[state=on]:bg-c-action" />'
      )
    ).toEqual([])
  })

  it.each([
    ['divide-gray-200', 'a static colour, the same in every theme'],
    ['border-b-gray-200', 'a static colour, the same in every theme'],
    ['outline-zinc-400', 'a static colour, the same in every theme'],
    ['ring-offset-slate-100', 'a static colour, the same in every theme'],
    ['shadow-gray-900', 'a static colour, the same in every theme'],
    ['decoration-red-500', 'a static colour, the same in every theme'],
    ['inset-ring-red-500', 'a static colour, the same in every theme'],
    ['inset-shadow-slate-900', 'a static colour, the same in every theme'],
    ['text-shadow-gray-900', 'a static colour, the same in every theme'],
    ['drop-shadow-zinc-900', 'a static colour, the same in every theme'],
    ['shadow-[0_8px_24px_rgba(47,58,69,0.25)]', 'an arbitrary colour, the same in every theme'],
    ['bg-[#ffffff]', 'an arbitrary colour, the same in every theme'],
    ['text-[var(--slate-900)]', 'an arbitrary colour, the same in every theme'],
    ['border-l-[theme(colors.slate.300)]', 'an arbitrary colour, the same in every theme'],
    ['bg-[red]', 'an arbitrary colour, the same in every theme'],
    ['text-[color:red]', 'an arbitrary colour, the same in every theme'],
    ['bg-[--slate-900]', 'an arbitrary colour, the same in every theme'],
    ['shadow-[0_0_0_1px_navy]', 'an arbitrary colour, the same in every theme'],
  ])(
    'refuses %s, a colour Tailwind compiles from its default palette or a literal',
    (className, reason) => {
      expect(problems(`<b className="p-2 ${className}" />`)).toEqual([{ className, reason }])
    }
  )

  it.each([
    ['{ color: "white" }', 'style color: white'],
    ["{ color: 'var(--slate-900)' }", 'style color: var(--slate-900)'],
    ["{ width: '50%', backgroundColor: '#fff' }", 'style backgroundColor: #fff'],
    ["{ boxShadow: '0 1px 2px rgba(0,0,0,.2)' }", 'style boxShadow: 0 1px 2px rgba(0,0,0,.2)'],
    ["{ border: '1px solid red' }", 'style border: 1px solid red'],
    ["{ border: '1px solid navy' }", 'style border: 1px solid navy'],
  ])('refuses an inline colour in style=%s', (style, className) => {
    expect(problems(`<b style={${style}} />`)).toEqual([
      { className, reason: 'an inline colour, the same in every theme' },
    ])
  })

  it('lets through what carries no static colour', () => {
    expect(
      problems(
        [
          '<b className="bg-transparent border-current text-inherit ring-offset-2 ring-offset-c-surface outline-offset-2 outline-c-action divide-c-border-soft text-[13px] bg-[url(/a.svg)] shadow-[0_0_0_1px_var(--c-border)]" />',
          "<b style={{ width: `${percent}%`, color: 'var(--c-ink)', background: 'transparent', border: '1px solid var(--c-border)' }} />",
          // A role referenced through `var(--c-…)` is not the class it spells.
          '<b style={{ color: \'var(--c-accent-ink)\' }} className="shadow-[0_0_0_1px_var(--c-accent-ink)] bg-[--c-surface] text-[length:var(--radix-size)]" />',
        ].join('\n')
      )
    ).toEqual([])
  })

  it('finds only themed colour classes anywhere under src', () => {
    const files = sourceFiles(SRC)
    const offending: string[] = []
    const excused = new Set<string>()
    let roleClasses = 0
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      roleClasses += source.match(/\b[a-z]+-c-[a-z]/g)?.length ?? 0
      for (const { className, reason } of problems(source)) {
        const entry = `${relative(SRC, path)} ${className}`
        if (NO_ROLE_YET.has(entry)) excused.add(entry)
        else offending.push(`${entry}: ${reason}`)
      }
    }
    expect(offending).toEqual([])
    expect([...NO_ROLE_YET].filter((entry) => !excused.has(entry))).toEqual([])
    expect(files.length).toBeGreaterThan(MIN_FILES)
    expect(roleClasses).toBeGreaterThan(MIN_ROLE_CLASSES)
  })
})
