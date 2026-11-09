// Shared test-only resolver for the real emitted entry/main and its canonical controls.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, type TestInfo } from '@playwright/test'
import ts from 'typescript'

export async function readBootstrapEntry(distDirectory: URL): Promise<string> {
  const html = await readFile(new URL('index.html', distDirectory), 'utf8')
  const matches = [...html.matchAll(/<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/g)]
  expect(matches).toHaveLength(1)
  const entry = matches[0]?.[1] ?? ''
  expect(entry.startsWith('/') && !entry.startsWith('//')).toBe(true)
  return entry
}

export function inspectBootstrapImports(ast: ts.SourceFile): {
  targets: string[]
  rejected: ts.CallExpression | undefined
} {
  const targets: string[] = []
  let rejected: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (
        node.arguments.length !== 1 ||
        argument === undefined ||
        !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        rejected ??= node
        return
      }
      targets.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { targets, rejected }
}

export async function mainArtifact({
  distDirectory,
  entry,
  origin,
  testInfo,
}: {
  distDirectory: URL
  entry: string
  origin: string
  testInfo: TestInfo
}): Promise<{
  path: string
  bootStart: number
  bootBodyStart: number
  bootEnd: number
  mainByteLength: number
  mainSha256: string
}> {
  const emittedBytes = await readFile(new URL('.' + entry, distDirectory))
  const emitted = emittedBytes.toString('utf8')
  const ast = ts.createSourceFile(
    'bootstrap.js',
    emitted,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const { targets, rejected } = inspectBootstrapImports(ast)
  if (rejected !== undefined) {
    const node = rejected
    // Observation only: preserve the original refusal and do not classify helper imports.
    try {
      const imports: {
        start: number
        end: number
        argumentCount: number
        argumentsTruncated: boolean
        arguments: { kind: string; text: string; fullLength: number }[]
        contextKind: string
        context: string
        contextFullLength: number
        contextTruncated: boolean
      }[] = []
      let totalImports = 0
      const inventory = (item: ts.Node): void => {
        if (ts.isCallExpression(item) && item.expression.kind === ts.SyntaxKind.ImportKeyword) {
          totalImports += 1
          if (imports.length < 16) {
            const context = item.parent.getText(ast)
            imports.push({
              start: item.getStart(ast),
              end: item.end,
              argumentCount: item.arguments.length,
              argumentsTruncated: item.arguments.length > 4,
              arguments: item.arguments.slice(0, 4).map((value) => {
                const text = value.getText(ast)
                return {
                  kind: ts.SyntaxKind[value.kind] ?? 'UnknownSyntaxKind',
                  text: text.slice(0, 160),
                  fullLength: text.length,
                }
              }),
              contextKind: ts.SyntaxKind[item.parent.kind] ?? 'UnknownSyntaxKind',
              context: context.slice(0, 768),
              contextFullLength: context.length,
              contextTruncated: context.length > 768,
            })
          }
        }
        ts.forEachChild(item, inventory)
      }
      inventory(ast)
      const bytes = emittedBytes
      const html = await readFile(new URL('index.html', distDirectory))
      const witness = {
        status: 'OBSERVATION_ONLY_ORIGINAL_IMPORT_REFUSAL_PRESERVED',
        entryPath: entry,
        entryBytes: bytes.byteLength,
        entrySha256: createHash('sha256').update(bytes).digest('hex'),
        htmlSha256: createHash('sha256').update(html).digest('hex'),
        emittedModuleGraphMappingObserved: false,
        totalImports,
        imports,
        importsTruncated: totalImports > imports.length,
        refusalStart: node.getStart(ast),
        refusalEnd: node.end,
        entryAttachmentWithinCap: bytes.byteLength <= 16_384,
      }
      const report = JSON.stringify(witness)
      if (Buffer.byteLength(report) <= 65_536) {
        await testInfo.attach('bootstrap-import-witness', {
          body: Buffer.from(report),
          contentType: 'application/json',
        })
        console.log('BOOTSTRAP_IMPORT_WITNESS ' + report)
      } else {
        console.error('BOOTSTRAP_IMPORT_WITNESS_CAP_REFUSED')
      }
      if (bytes.byteLength <= 16_384) {
        await testInfo.attach('actual-emitted-bootstrap', {
          body: bytes,
          contentType: 'text/javascript',
        })
      } else {
        console.error('BOOTSTRAP_ENTRY_ATTACHMENT_CAP_REFUSED')
      }
    } catch (diagnosticError) {
      const secondary =
        diagnosticError instanceof Error
          ? {
              name: diagnosticError.name.slice(0, 64),
              message: diagnosticError.message.slice(0, 256),
            }
          : { type: typeof diagnosticError }
      console.error('BOOTSTRAP_IMPORT_WITNESS_FAILED ' + JSON.stringify(secondary))
    }
    throw Error('NONLITERAL_BOOTSTRAP_IMPORT')
  }
  expect(targets, 'ONE_REAL_DYNAMIC_MAIN_TARGET').toHaveLength(1)
  const target = targets[0]
  if (target === undefined) throw Error('MAIN_TARGET_ABSENT')
  const url = new URL(target, origin + entry)
  expect(url.origin).toBe(origin)
  expect(url.search + url.hash).toBe('')
  expect(url.pathname).not.toBe(entry)
  const mainBytes = await readFile(new URL('.' + url.pathname, distDirectory))
  const main = mainBytes.toString('utf8')
  const module = ts.createSourceFile(
    'main.js',
    main,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  let local = ''
  for (const statement of module.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const boot = statement.exportClause.elements.find((item) => item.name.text === 'boot')
      if (boot !== undefined) local = (boot.propertyName ?? boot.name).text
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'boot' &&
      statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)
    )
      local = 'boot'
  }
  let definition: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined
  for (const statement of module.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === local)
      definition = statement
    if (ts.isVariableStatement(statement)) {
      const binding = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === local
      )
      if (
        binding?.initializer !== undefined &&
        (ts.isFunctionExpression(binding.initializer) || ts.isArrowFunction(binding.initializer))
      )
        definition = binding.initializer
    }
  }
  if (local === '' || definition?.body === undefined)
    throw Error('REAL_MAIN_BOOT_EXPORT_NOT_RESOLVED')
  return {
    path: url.pathname,
    bootStart: definition.getStart(module),
    bootBodyStart: definition.body.getStart(module),
    bootEnd: definition.end,
    mainByteLength: mainBytes.byteLength,
    mainSha256: createHash('sha256').update(mainBytes).digest('hex'),
  }
}
