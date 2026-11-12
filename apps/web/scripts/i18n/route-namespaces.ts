// Proves, from the source alone, that no screen can render before its message namespace is there.
//
// The runtime loads a namespace at a lazy route boundary: `withNamespaces([...], () => import(...))`
// (`src/i18n/index.ts`) delivers a module together with the catalogues named beside it, and the
// route tree attaches a route only once that has resolved (`src/app/lazyRouteTree.ts`). So the
// question "is the text there when this screen renders?" has a static answer: follow the imports.
//
// - The entry is everything `src/main.tsx` reaches without crossing such a boundary. It may read
//   the entry namespaces (`ENTRY_NAMESPACES`) and nothing else.
// - Beyond a boundary, a module may also read the namespaces the boundary names. A unit of
//   `ROUTE_UNITS` other than `organisation` hangs below the organisation layout and may count on
//   its namespaces too.
// - A plain `import()` — a lazy component inside an area — loads no catalogue, so what it reaches
//   belongs to whoever imported it.
//
// The simulation layer (`src/mocks/`) is not followed. It is no screen: it answers the requests
// screens make, in builds that carry it — never a production one
// (`scripts/check-production-bundle.sh`) — and a sentence it words is worded for a screen that is
// already up, with that screen's namespaces.
//
// A "read" is any string or template literal that starts like a catalogue key, `console.<namespace>.`:
// a `t('…')` argument, an entry of a table of keys, the fixed head of a key built with `${…}`.
// Comments are not literals and do not count.
//
// One thing the imports cannot show: a boundary fetches the module and its catalogues side by
// side, so the module's own top-level code may run before the catalogues are in. A screen renders
// later, once the route is attached; a translation taken at module scope (`const title =
// i18n.t('…')`) would be taken at once, and keep whatever it got. That is refused wherever it is
// written.
//
// Refusals: a module that reads a namespace not available where it is reachable, a translation
// taken at module scope, a boundary that names something that is not a namespace, an import this
// cannot resolve.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const BOUNDARY_FUNCTION = 'withNamespaces'
const UNIT_REGISTRY = 'ROUTE_UNITS'
const LAYOUT_UNIT = 'organisation'
/** Relative to the source directory. See the note on the simulation layer above. */
const SIMULATION_DIRECTORY = 'mocks'

interface Boundary {
  /** The unit's name in `ROUTE_UNITS`, when the boundary is one of its entries. */
  unit: string | undefined
  namespaces: string[]
  targets: string[]
  file: string
}

interface ParsedModule {
  /** Modules reached by a static import or a plain `import()`. */
  imports: string[]
  boundaries: Boundary[]
  /** namespace -> one literal that reads it, for the message. */
  reads: Map<string, string>
}

export interface RouteNamespaceInput {
  /** The directory `@/` stands for. */
  srcDir: string
  /** The module the application starts from. */
  entry: string
  namespaces: readonly string[]
  entryNamespaces: readonly string[]
  /** The lists a boundary may name instead of writing one out: the exports of the namespaces module. */
  namedLists?: Readonly<Record<string, readonly string[]>>
}

export interface RouteNamespaceContext {
  name: string
  modules: number
  /** What the context may read beyond the entry namespaces. */
  namespaces: string[]
  /** Named at the boundary and read by nothing behind it. */
  unused: string[]
}

export interface RouteNamespaceResult {
  problems: string[]
  contexts: RouteNamespaceContext[]
}

function resolveModule(specifier: string, from: string, srcDir: string): string | undefined | null {
  let base: string
  if (specifier.startsWith('@/')) base = join(srcDir, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
  else return null // a package: no catalogue key lives there
  const [path = base] = base.split('?')
  const isFile = (candidate: string) => existsSync(candidate) && statSync(candidate).isFile()
  if (isFile(path)) return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) ? path : null
  for (const extension of SOURCE_EXTENSIONS) {
    if (isFile(path + extension)) return path + extension
  }
  for (const extension of SOURCE_EXTENSIONS) {
    if (isFile(join(path, `index${extension}`))) return join(path, `index${extension}`)
  }
  return undefined
}

function isDynamicImport(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
}

function parseModule(file: string, input: RouteNamespaceInput, problems: string[]): ParsedModule {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const known = new Set(input.namespaces)
  const parsed: ParsedModule = { imports: [], boundaries: [], reads: new Map() }
  const shown = relative(dirname(input.srcDir), file)

  const simulation = join(input.srcDir, SIMULATION_DIRECTORY) + sep
  const follow = (specifier: string): string | undefined => {
    const resolved = resolveModule(specifier, file, input.srcDir)
    if (resolved === undefined) problems.push(`${shown}: cannot resolve the import "${specifier}"`)
    return resolved == null || resolved.startsWith(simulation) ? undefined : resolved
  }
  const read = (text: string) => {
    const namespace = /^console\.([a-z]+)\./.exec(text)?.[1]
    if (namespace !== undefined && known.has(namespace) && !parsed.reads.has(namespace)) {
      parsed.reads.set(namespace, text)
    }
  }
  const unitOf = (node: ts.Node): string | undefined => {
    let unit: string | undefined
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
      if (
        ts.isPropertyAssignment(current) &&
        ts.isObjectLiteralExpression(current.parent) &&
        ts.isVariableDeclaration(current.parent.parent) &&
        ts.isIdentifier(current.parent.parent.name) &&
        current.parent.parent.name.text === UNIT_REGISTRY &&
        (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name))
      ) {
        unit = current.name.text
      }
    }
    return unit
  }

  const visit = (node: ts.Node, insideBoundary: Boundary | undefined) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly === true
        : node.isTypeOnly
      if (
        !typeOnly &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const resolved = follow(node.moduleSpecifier.text)
        if (resolved !== undefined) parsed.imports.push(resolved)
      }
      return
    }
    // `typeof import('…')` in a type position is erased; it reaches nothing at run time.
    if (ts.isImportTypeNode(node)) return
    if (isDynamicImport(node)) {
      const [specifier] = node.arguments
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
        const resolved = follow(specifier.text)
        if (resolved !== undefined) {
          if (insideBoundary === undefined) parsed.imports.push(resolved)
          else insideBoundary.targets.push(resolved)
        }
      } else {
        problems.push(
          `${shown}: an import() whose module is not a string literal cannot be followed`
        )
      }
      return
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === BOUNDARY_FUNCTION
    ) {
      const [names, load] = node.arguments
      const boundary: Boundary = { unit: unitOf(node), namespaces: [], targets: [], file }
      const named =
        names !== undefined && ts.isIdentifier(names) ? input.namedLists?.[names.text] : undefined
      if (
        names === undefined ||
        load === undefined ||
        (!ts.isArrayLiteralExpression(names) && named === undefined)
      ) {
        problems.push(
          `${shown}: ${BOUNDARY_FUNCTION} must be called with a list of namespaces (a literal, or a list src/i18n/namespaces.ts exports) and a loader`
        )
        return
      }
      const listed: (string | undefined)[] = ts.isArrayLiteralExpression(names)
        ? names.elements.map((element) =>
            ts.isStringLiteralLike(element) ? element.text : undefined
          )
        : [...(named ?? [])]
      for (const namespace of listed) {
        if (namespace === undefined) {
          problems.push(
            `${shown}: ${BOUNDARY_FUNCTION} names a namespace that is not a string literal`
          )
        } else if (!known.has(namespace)) {
          problems.push(
            `${shown}: ${BOUNDARY_FUNCTION} names "${namespace}", which is not a message namespace`
          )
        } else {
          boundary.namespaces.push(namespace)
        }
      }
      visit(load, boundary)
      if (boundary.targets.length === 0) {
        problems.push(`${shown}: ${BOUNDARY_FUNCTION} is given a loader that imports nothing`)
      }
      parsed.boundaries.push(boundary)
      return
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'i18n' &&
      node.expression.name.text === 't' &&
      ts.findAncestor(node, ts.isFunctionLike) === undefined
    ) {
      problems.push(
        `${shown}: i18n.t(…) is called at module scope, where it can run before the namespace it reads has arrived: call it where the text is rendered`
      )
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) read(node.text)
    else if (ts.isTemplateExpression(node)) read(node.head.text)
    ts.forEachChild(node, (child) => visit(child, insideBoundary))
  }
  visit(source, undefined)
  return parsed
}

export function checkRouteNamespaces(input: RouteNamespaceInput): RouteNamespaceResult {
  const problems: string[] = []
  const modules = new Map<string, ParsedModule>()
  const parse = (file: string): ParsedModule => {
    let parsed = modules.get(file)
    if (parsed === undefined) {
      parsed = parseModule(file, input, problems)
      modules.set(file, parsed)
    }
    return parsed
  }
  const closure = (roots: readonly string[]): string[] => {
    const seen = new Set<string>()
    const queue = [...roots]
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue
      seen.add(file)
      queue.push(...parse(file).imports)
    }
    return [...seen].sort()
  }
  const shown = (file: string) => relative(dirname(input.srcDir), file)
  const contexts: RouteNamespaceContext[] = []
  const visited = new Set<string>()

  if (!existsSync(input.entry)) {
    return { problems: [`the application entry ${shown(input.entry)} does not exist`], contexts }
  }

  const check = (
    name: string,
    roots: readonly string[],
    available: ReadonlySet<string>,
    own: readonly string[],
    where: string
  ) => {
    const key = `${[...roots].sort().join('|')}#${[...available].sort().join(',')}`
    if (visited.has(key)) return
    visited.add(key)
    const files = closure(roots)
    const read = new Set<string>()
    for (const file of files) {
      for (const [namespace, literal] of parse(file).reads) {
        read.add(namespace)
        if (!available.has(namespace)) {
          problems.push(
            `${shown(file)} reads "${literal}" and is reachable from ${name}, where the "${namespace}" namespace is not loaded: name it at ${where}`
          )
        }
      }
    }
    contexts.push({
      name,
      modules: files.length,
      namespaces: [...own].sort(),
      unused: own.filter((namespace) => !read.has(namespace)).sort(),
    })
    const boundaries = files.flatMap((file) => parse(file).boundaries)
    const layout = boundaries.find((boundary) => boundary.unit === LAYOUT_UNIT)
    if (boundaries.some((boundary) => boundary.unit !== undefined) && layout === undefined) {
      problems.push(`${UNIT_REGISTRY} has no "${LAYOUT_UNIT}" unit for its areas to hang below`)
    }
    for (const boundary of boundaries) {
      const inherited =
        boundary.unit !== undefined && boundary.unit !== LAYOUT_UNIT
          ? (layout?.namespaces ?? [])
          : []
      check(
        boundary.unit === undefined
          ? `the lazy route ${boundary.targets.map(shown).join(', ')}`
          : `the "${boundary.unit}" route unit`,
        boundary.targets,
        new Set([...available, ...inherited, ...boundary.namespaces]),
        boundary.namespaces,
        `its ${BOUNDARY_FUNCTION} call in ${shown(boundary.file)}`
      )
    }
  }

  check(
    'the application entry',
    [input.entry],
    new Set(input.entryNamespaces),
    [],
    'ENTRY_NAMESPACES (src/i18n/namespaces.ts), or move the screen behind a lazy route'
  )
  return { problems: [...new Set(problems)], contexts }
}
