// Discovers scenario overlays by file name, so adding one is a new file and
// nothing else — there is no registry to edit, and therefore no file every
// builder touching a different area conflicts on (ADR-0005, docs/dev/TESTING.md
// §2). `useScenario` (tests/e2e/support/useScenario.ts) writes the chosen
// names to `sessionStorage['msw:scenarios']`; `src/mocks/browser.ts` reads
// them back and resolves them here.
//
// The glob pattern is `./*.ts` rather than the `./overlays/*.ts` a file
// living one level up would use: this module lives inside the directory it
// scans, so it excludes itself by name instead of by a segment that would
// otherwise double (`overlays/overlays/*.ts`, which resolves to nothing).

import type { HttpHandler } from 'msw/http'

interface OverlayModule {
  readonly handlers: HttpHandler[]
}

const modules = import.meta.glob<OverlayModule>('./*.ts', { eager: true })

function overlayName(path: string): string {
  return path.replace(/^\.\//, '').replace(/\.ts$/, '')
}

const byName = new Map<string, HttpHandler[]>()
for (const [path, mod] of Object.entries(modules)) {
  if (path.endsWith('/index-glob.ts')) continue
  byName.set(overlayName(path), mod.handlers)
}

/**
 * Resolves scenario names to their handlers, composed so the scenario named
 * LAST wins when two overlays answer the same route — the order
 * `useScenario` is called with reads as "apply this, then refine it with
 * that". MSW itself resolves the first matching handler in a list, so the
 * last-named scenario's handlers are placed first here, not appended last.
 *
 * Throws, naming the scenario, on a name nothing under this directory
 * exports: an overlay an end-to-end spec asks for by a misspelt name must
 * fail loudly, not run against the base handlers as if nothing were wrong.
 */
export function resolveOverlays(names: readonly string[]): HttpHandler[] {
  const result: HttpHandler[] = []
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i]
    if (name === undefined) continue
    const handlers = byName.get(name)
    if (handlers === undefined) {
      throw new Error(
        `Unknown MSW scenario "${name}". Overlays live in src/mocks/overlays/<name>.ts ` +
          'and are discovered by file name — check the spelling against the file.'
      )
    }
    result.push(...handlers)
  }
  return result
}
