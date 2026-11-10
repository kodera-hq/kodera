// Every schema entry point must evaluate the CSP-safe policy first.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { z } from '@/validation-policy'

function bypasses(text: string): boolean {
  const source = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true)
  let bypass = false
  const isZod = (node: ts.Node | undefined) =>
    node !== undefined &&
    ts.isStringLiteral(node) &&
    (node.text === 'zod' || node.text.startsWith('zod/'))
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && isZod(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const onlyTypes =
        clause?.isTypeOnly ||
        (bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((binding) => binding.isTypeOnly))
      if (!onlyTypes) bypass = true
    }
    if (ts.isExportDeclaration(node) && isZod(node.moduleSpecifier) && !node.isTypeOnly)
      bypass = true
    if (ts.isCallExpression(node) && isZod(node.arguments[0])) bypass = true
    ts.forEachChild(node, visit)
  }
  visit(source)
  return bypass
}

it.each([
  "import { z } from 'zod'",
  "import * as schemas from 'zod'",
  "export { z } from 'zod/v4'",
  "const z = await import('zod')",
  "const z = require('zod')",
])('detects a policy bypass: %s', (source) => expect(bypasses(source)).toBe(true))
it('allows type-only imports and policy imports', () => {
  expect(bypasses("import type { ZodType } from 'zod'")).toBe(false)
  expect(bypasses("import { type ZodType } from 'zod'")).toBe(false)
  expect(bypasses("import { z } from '@/validation-policy'")).toBe(false)
})
it('has no direct runtime Zod imports outside the policy module', () => {
  const root = join(import.meta.dirname, '../../src')
  const findings: string[] = []
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (
        /\.tsx?$/.test(entry.name) &&
        path !== join(root, 'validation-policy.ts') &&
        bypasses(readFileSync(path, 'utf8'))
      ) {
        findings.push(relative(root, path))
      }
    }
  }
  walk(root)
  expect(findings).toEqual([])
  expect(z.config().jitless).toBe(true)
})
