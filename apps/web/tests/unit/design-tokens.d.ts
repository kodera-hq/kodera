// `@kodera/design-tokens/token-test` is plain ESM JavaScript with no types of
// its own (the package has no build step on purpose — see its README). Without
// this declaration TypeScript resolves the module and then reports it as an
// implicit `any`, which `strict` turns into an error. Declaring the shape here
// also means a signature change in the package shows up as a type error rather
// than as a test that quietly stops asserting.
declare module '@kodera/design-tokens/token-test' {
  /**
   * The utility prefixes that take a colour token, in the order the package
   * scans them. Imported rather than re-listed by `tests/unit/ui/tokens.test.ts`
   * so its own checks judge exactly the prefixes the resolution scanner judges —
   * a prefix added upstream must not silently stay unguarded here.
   */
  export const DEFAULT_PREFIXES: string[]

  export interface TokenScanResult {
    files: number
    matched: string[]
    unresolved: string[]
  }

  export interface AssertClassesResolveOptions {
    files: string[]
    preset: unknown
    prefixes?: string[]
    minFiles?: number
    minMatches?: number
  }

  export function sourceFiles(
    dir: string,
    options?: { extensions?: RegExp; ignore?: RegExp }
  ): string[]

  export function assertClassesResolve(options: AssertClassesResolveOptions): TokenScanResult

  export interface ScannedClass {
    prefix: string
    rest: string
    className: string
  }

  // The lower-level pieces `assertClassesResolve` is built from — used by
  // `tests/unit/ui/index-css.test.ts` to judge `src/index.css`, which
  // `assertClassesResolve`'s own `sourceFiles` walk never reaches (no `.css`
  // in its default extensions).
  export function familiesOf(preset: unknown): Set<string>

  export function resolvesInPreset(preset: unknown, key: string): boolean

  export function scanClasses(
    source: string,
    options: { families: Set<string>; prefixes?: string[] }
  ): ScannedClass[]
}
