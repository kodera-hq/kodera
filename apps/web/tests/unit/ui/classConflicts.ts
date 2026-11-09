import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

// Two colour classes for the same property under the same variants, on one
// element, do not merge: `cx` joins strings, and the stylesheet decides. For
// two same-plugin utilities Tailwind 3 emits candidates in sorted order, so the
// alphabetically later class wins whatever the source says. A conditional
// state class (`dragging && 'border-c-accent-ink'`) beside an unconditional
// base (`border-c-ink-4`) therefore loses whenever it sorts first.
//
// This reads the TypeScript syntax tree, not the text, and works out every
// combination of classes one element can carry: string and template literals,
// `cx(…)`, `a ? b : c`, `a && b`, `a || b`, `a ?? b`, a `const` in the same
// file or imported from another file under `src/`, a `Record` indexed by a
// variable (every entry is a possibility), and a router `Link`'s `className`
// joined with its `activeProps` and `inactiveProps` class names. What it cannot
// see counts as no class: a prop, a value computed at run time, and a component
// that adds its own classes to a caller's `className`.

/** Colour utilities, keyed by the CSS property they set. */
const COLOUR_CLASS =
  /^(text|bg|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|divide|decoration|shadow|caret|accent|placeholder)-(c-[a-z0-9-]+|transparent|current|inherit)(?:\/\d+)?$/

/** The variants-and-property key two conflicting classes share, or undefined. */
export function conflictKey(className: string): string | undefined {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of className.replace(/^!/, '')) {
    if (char === '[') depth += 1
    if (char === ']') depth -= 1
    if (char === ':' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  const utility = COLOUR_CLASS.exec(current)
  if (utility === null) return undefined
  return [...parts.sort(), utility[1]].join(':')
}

type Options = string[][]
const LIMIT = 4096
const NOTHING: Options = [[]]

function product(left: Options, right: Options): Options {
  const out: Options = []
  for (const a of left) for (const b of right) if (out.length < LIMIT) out.push([...a, ...b])
  return out
}

const tokens = (text: string) => text.split(/\s+/).filter(Boolean)

function unwrap(node: ts.Expression): ts.Expression {
  let target = node
  while (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isSatisfiesExpression(target)
  )
    target = target.expression
  return target
}

interface Module {
  file: ts.SourceFile
  constants: Map<string, ts.Expression[]>
  imports: Map<string, string>
}

export interface Conflict {
  line: number
  classes: [string, string]
}

/**
 * Every pair of conflicting colour classes one element in `fileName` can
 * carry. `srcRoot` resolves the `@/` alias; relative imports resolve from the
 * file itself.
 */
export function classConflicts(fileName: string, source: string, srcRoot: string): Conflict[] {
  const modules = new Map<string, Module | undefined>()
  const load = (path: string, text?: string): Module | undefined => {
    if (modules.has(path)) return modules.get(path)
    const body = text ?? (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
    if (body === undefined) {
      modules.set(path, undefined)
      return undefined
    }
    const file = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const constants = new Map<string, ts.Expression[]>()
    const imports = new Map<string, string>()
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        constants.set(node.name.text, [...(constants.get(node.name.text) ?? []), node.initializer])
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        const specifier = node.moduleSpecifier.text
        const base = specifier.startsWith('@/')
          ? join(srcRoot, specifier.slice(2))
          : specifier.startsWith('.')
            ? resolve(dirname(path), specifier)
            : undefined
        if (base !== undefined)
          for (const element of node.importClause.namedBindings.elements) {
            const target = ['.ts', '.tsx'].map((ext) => base + ext).find((p) => existsSync(p))
            if (target !== undefined) imports.set(element.name.text, target)
          }
      }
      ts.forEachChild(node, collect)
    }
    collect(file)
    const module = { file, constants, imports }
    modules.set(path, module)
    return module
  }

  const resolving = new Set<string>()
  const definitions = (name: string, module: Module): [ts.Expression, Module][] => {
    const local = module.constants.get(name)
    if (local !== undefined) return local.map((node) => [node, module])
    const from = module.imports.get(name)
    const other = from === undefined ? undefined : load(from)
    return other?.constants.get(name)?.map((node) => [node, other]) ?? []
  }
  const objectLiteral = (
    node: ts.Expression,
    module: Module
  ): [ts.ObjectLiteralExpression, Module] | undefined => {
    const target = unwrap(node)
    if (ts.isObjectLiteralExpression(target)) return [target, module]
    if (ts.isIdentifier(target)) {
      const found = definitions(target.text, module)
      return found.length === 1 && found[0] !== undefined
        ? objectLiteral(found[0][0], found[0][1])
        : undefined
    }
    return undefined
  }
  const property = (record: ts.ObjectLiteralExpression, name: string, module: Module) =>
    record.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && p.name.getText(module.file) === name
    )

  const evaluate = (raw: ts.Expression, module: Module): Options => {
    const node = unwrap(raw)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return [tokens(node.text)]
    if (ts.isTemplateExpression(node)) {
      let out: Options = [tokens(node.head.text)]
      for (const span of node.templateSpans)
        out = product(product(out, evaluate(span.expression, module)), [tokens(span.literal.text)])
      return out
    }
    if (ts.isIdentifier(node)) {
      const key = `${module.file.fileName}#${node.text}`
      const found = definitions(node.text, module)
      if (found.length === 0 || resolving.has(key)) return NOTHING
      resolving.add(key)
      const out = found.flatMap(([definition, owner]) => evaluate(definition, owner))
      resolving.delete(key)
      return out
    }
    if (ts.isConditionalExpression(node))
      return [...evaluate(node.whenTrue, module), ...evaluate(node.whenFalse, module)]
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return [...evaluate(node.right, module), []]
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
        return [...evaluate(node.left, module), ...evaluate(node.right, module)]
      return NOTHING
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'cx'
    )
      return node.arguments.reduce<Options>(
        (out, arg) => product(out, evaluate(arg, module)),
        NOTHING
      )
    if (ts.isElementAccessExpression(node)) {
      const found = objectLiteral(node.expression, module)
      if (found === undefined) return NOTHING
      const [record, owner] = found
      return record.properties.flatMap((p) =>
        ts.isPropertyAssignment(p) ? evaluate(p.initializer, owner) : []
      )
    }
    if (ts.isPropertyAccessExpression(node)) {
      const found = objectLiteral(node.expression, module)
      if (found === undefined) return NOTHING
      const [record, owner] = found
      const value = property(record, node.name.text, owner)
      return value === undefined ? NOTHING : evaluate(value.initializer, owner)
    }
    return NOTHING
  }

  const root = load(fileName, source)
  if (root === undefined) return []
  const attributeValue = (attribute: ts.JsxAttribute): Options => {
    const value = attribute.initializer
    if (value === undefined) return NOTHING
    if (ts.isStringLiteral(value)) return [tokens(value.text)]
    if (ts.isJsxExpression(value) && value.expression) return evaluate(value.expression, root)
    return NOTHING
  }
  const propsClassName = (attribute: ts.JsxAttribute): Options | undefined => {
    const value = attribute.initializer
    if (value === undefined || !ts.isJsxExpression(value) || value.expression === undefined)
      return undefined
    const found = objectLiteral(value.expression, root)
    if (found === undefined) return undefined
    const className = property(found[0], 'className', found[1])
    return className === undefined ? undefined : evaluate(className.initializer, found[1])
  }

  const conflicts: Conflict[] = []
  const seen = new Set<string>()
  const judge = (at: ts.Node, options: Options) => {
    for (const option of options) {
      const byKey = new Map<string, string>()
      for (const className of new Set(option)) {
        const key = conflictKey(className)
        if (key === undefined) continue
        const other = byKey.get(key)
        if (other === undefined) {
          byKey.set(key, className)
          continue
        }
        const line = root.file.getLineAndCharacterOfPosition(at.getStart(root.file)).line + 1
        const pair = [other, className].sort() as [string, string]
        const id = `${line} ${pair.join(' ')}`
        if (!seen.has(id)) {
          seen.add(id)
          conflicts.push({ line, classes: pair })
        }
      }
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
      const named = (name: string) => attributes.find((a) => a.name.getText(root.file) === name)
      const className = named('className')
      const base = className === undefined ? NOTHING : attributeValue(className)
      judge(node, base)
      for (const name of ['activeProps', 'inactiveProps']) {
        const props = named(name)
        const extra = props === undefined ? undefined : propsClassName(props)
        if (extra !== undefined) judge(node, product(base, extra))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root.file)
  return conflicts
}
