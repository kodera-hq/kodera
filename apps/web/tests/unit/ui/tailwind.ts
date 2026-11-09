import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import preset from '@kodera/design-tokens/tailwind-preset'
import { compile, optimize } from '@tailwindcss/node'
import postcss from 'postcss'

// What the tests that read compiled CSS compile with: the console's own
// stylesheet, `src/index.css`, through the compiler `@tailwindcss/vite` runs,
// then `optimize` from `@tailwindcss/node`: Lightning CSS, the copy that
// package pins, which flattens nesting into the selectors a build ships. It is
// not byte for byte the production pass (Vite minifies afterwards with its own
// Lightning CSS, of another version). Only the classes named are built, so a
// test sees exactly the rules those classes produce, and the stylesheet's own
// rules (`focus-offset`, `focus-ground-*`).
const INDEX_CSS = join(import.meta.dirname, '..', '..', '..', 'src', 'index.css')

/** Every class of an element and of everything inside it. */
export function classesOf(element: Element): string[] {
  return [element, ...Array.from(element.querySelectorAll('[class]'))].flatMap((node) =>
    Array.from(node.classList)
  )
}

/** The compiled stylesheet for exactly these classes. */
export async function compiled(classes: Iterable<string>): Promise<postcss.Root> {
  const compiler = await compile(readFileSync(INDEX_CSS, 'utf8'), {
    base: dirname(INDEX_CSS),
    from: INDEX_CSS,
    onDependency: () => undefined,
  })
  return postcss.parse(optimize(compiler.build([...classes])).code)
}

// The colour families a class can name in this repo: the preset's own and the
// default palette Tailwind 4 ships in `tailwindcss/theme.css`, which the preset
// extends rather than replaces. Derived, not listed: a family the preset adds
// or Tailwind ships appears here on its own. `transparent`, `current` and
// `inherit` are keywords, not families, and are left to each caller.
const THEME_CSS = createRequire(import.meta.url).resolve('tailwindcss/theme.css')
export const COLOUR_FAMILIES: ReadonlySet<string> = new Set([
  ...Object.keys(preset.theme.extend.colors as Record<string, unknown>).map(
    (key) => key.split('-')[0] ?? key
  ),
  ...[...readFileSync(THEME_CSS, 'utf8').matchAll(/--color-([a-z]+)[-:]/g)].map(
    ([, family = '']) => family
  ),
  'transparent',
  'current',
  'inherit',
])
