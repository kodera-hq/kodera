import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(path.resolve('apps/web/package.json'))
const ts = require('typescript')
const testManifest = require.resolve('@playwright/test/package.json')
const testRequire = createRequire(testManifest)
const playwrightManifest = testRequire.resolve('playwright/package.json')
const playwrightRequire = createRequire(playwrightManifest)
const coreManifest = playwrightRequire.resolve('playwright-core/package.json')
const browserManifest = path.join(path.dirname(coreManifest), 'browsers.json')
const playwrightManifests = [testManifest, playwrightManifest, coreManifest]
const root = process.env.WASM_PROOF_ROOT
const need = (value, reason) => { if (!value) throw new Error(reason) }
need(root && fs.realpathSync(root) === root, 'private root')
need(playwrightManifests.every((name) => JSON.parse(fs.readFileSync(name, 'utf8')).version === '1.65.1'), 'locked browser package versions')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'artifact-manifest.json'), 'utf8'))
need(manifest.schema === 'wasm-device-proof-v1' && manifest.files.length <= 128, 'manifest')
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const actualModuleInventory = []
for (const record of manifest.files) {
  const name = path.join(root, 'generated', record.path)
  need(fs.realpathSync(name) === name && fs.lstatSync(name).isFile(), 'generated regular file')
  const bytes = fs.readFileSync(name)
  need(bytes.length === record.bytes && hash(bytes) === record.sha256, 'generated hash')
  if (!record.path.endsWith('.js')) continue
  const source = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = source.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text)
  const exported = source.statements.flatMap((node) => {
    if (ts.isExportDeclaration(node)) return node.exportClause && ts.isNamedExports(node.exportClause)
      ? node.exportClause.elements.map((part) => part.name.text) : ['*']
    if (node.modifiers?.some((part) => part.kind === ts.SyntaxKind.ExportKeyword))
      return node.name ? [node.name.getText(source)] : ts.isVariableStatement(node)
        ? node.declarationList.declarations.map((part) => part.name.getText(source)) : ['default']
    return []
  })
  actualModuleInventory.push({ path: record.path, imports, exports: exported })
  for (const specifier of imports) {
    need(typeof specifier === 'string' && specifier.startsWith('./') && !specifier.includes('\\') && !specifier.includes('%'), 'generated module import')
    const imported = path.resolve(path.dirname(name), specifier)
    need(imported.startsWith(path.join(root, 'generated') + path.sep) && fs.realpathSync(imported) === imported &&
      manifest.files.some((entry) => path.join(root, 'generated', entry.path) === imported), 'generated module closure')
  }
}
const location = path.dirname(fileURLToPath(import.meta.url))
const httpInventoryPath = path.join(location, 'http-cases.json')
need(fs.realpathSync(httpInventoryPath) === httpInventoryPath && fs.lstatSync(httpInventoryPath).isFile() &&
  fs.statSync(httpInventoryPath).size <= 8192, 'closed supplemental inventory file')
const httpInventoryBytes = fs.readFileSync(httpInventoryPath)
const httpInventory = JSON.parse(httpInventoryBytes.toString('utf8'))
need(Object.keys(httpInventory).sort().join(',') === 'cases,hostOracleOnly,schema' &&
  httpInventory.schema === 'wasm-device-http-host-oracle-v1' && httpInventory.hostOracleOnly === true &&
  Array.isArray(httpInventory.cases) && httpInventory.cases.length === 35 && new Set(httpInventory.cases).size === 35 &&
  httpInventory.cases.every((name) => typeof name === 'string' && /^http-[a-z-]{1,60}$/.test(name)), 'closed host-oracle supplemental inventory')
const httpFixtureSources = []
for (const [relative, variable, frozen] of [['http-device.spec.mjs', 'cases', false], ['fixtures/http-host-adapter.mjs', 'CASES', true]]) {
  const filename = path.join(location, relative), bytes = fs.readFileSync(filename)
  need(bytes.length <= 128 * 1024, 'HTTP fixture source cap')
  const tree = ts.createSourceFile(filename, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const declarations = tree.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations])
  const matches = declarations.filter((node) => ts.isIdentifier(node.name) && node.name.text === variable)
  need(matches.length === 1, 'single source HTTP inventory')
  let value = matches[0].initializer
  if (frozen) {
    need(value && ts.isCallExpression(value) && value.expression.getText(tree) === 'Object.freeze' && value.arguments.length === 1, 'frozen HTTP worker inventory')
    value = value.arguments[0]
  }
  need(value && ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteral), 'literal HTTP fixture inventory')
  need(JSON.stringify(value.elements.map((node) => node.text)) === JSON.stringify(httpInventory.cases), 'HTTP fixture inventories differ')
  httpFixtureSources.push({ path: relative, sha256: hash(bytes) })
}
const httpClientBytes = fs.readFileSync(path.join(location, 'fixtures/http-client.mjs'))
need(httpClientBytes.length <= 128 * 1024, 'HTTP client source cap')
httpFixtureSources.push({ path: 'fixtures/http-client.mjs', sha256: hash(httpClientBytes) })
const abi = path.join(root, 'abi.ts')
fs.writeFileSync(abi, fs.readFileSync(path.join(location, 'fixtures/abi.ts.fixture')), { flag: 'wx', mode: 0o600 })
const storage = path.resolve('apps/web/src/features/confidential/local-state.ts')
const transport = ['local-state', 'device-http-record', 'device-cas-host'].map((name) => ({
  name, path: path.resolve(`apps/web/src/features/confidential/${name}.ts`),
  imports: name === 'device-cas-host' ? ['./local-state', './device-http-record'] : [],
}))
const declaration = path.join(root, 'generated/kodera_rs.d.ts')
const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmitOnError: true, types: [],
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.esnext.disposable.d.ts'] }
const inputs = [abi, ...transport.map((row) => row.path)]
const program = ts.createProgram(inputs, options)
const diagnostics = ts.getPreEmitDiagnostics(program)
need(diagnostics.length === 0, 'actual generated ABI semantic diagnostics: ' + diagnostics.map((row) => row.code).join(','))
const source = program.getSourceFile(declaration)
need(source, 'actual declaration absent')
const klass = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'BrowserMlsDevice')
need(klass, 'actual class absent')
const mandatory = ['createDevice', 'openDevice', 'publicKey', 'registrationRequest', 'close', 'free']
const methods = klass.members.filter(ts.isMethodDeclaration).map((node) => node.name.getText(source))
need(mandatory.every((name) => methods.includes(name)) && methods.every((name) => mandatory.includes(name) || name === '[Symbol.dispose]'), 'closed actual class methods')
const httpClass = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'BrowserMlsHttpDevice')
need(httpClass, 'actual HTTP class absent')
const httpMandatory = ['createHttpDevice', 'openHttpDevice', 'prepareRegistration', 'preparePublication', 'attemptHttp', 'publicKey', 'close', 'free']
const httpMethods = httpClass.members.filter(ts.isMethodDeclaration).map((node) => node.name.getText(source))
need(httpMandatory.every((name) => httpMethods.includes(name)) && httpMethods.every((name) => httpMandatory.includes(name) || name === '[Symbol.dispose]'), 'closed actual HTTP class methods')
const storageSource = program.getSourceFile(storage)
need(storageSource && storageSource.text.includes('readUniqueDeviceVault') && storageSource.text.includes('createUniqueDeviceVault'), 'reviewed unique API missing from base')
const emitted = []
const compiledTransport = []
const result = program.emit(undefined, (name, text) => {
  const basename = path.basename(name), row = transport.find((entry) => basename === entry.name + '.js')
  need(row || basename === 'abi.js', 'unexpected fixture emit')
  if (!row) return
  need(!emitted.includes(row.name) && Buffer.byteLength(text) <= 128 * 1024, 'unique bounded transport emit')
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = tree.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text)
  need(JSON.stringify([...imports].sort()) === JSON.stringify([...row.imports].sort()), 'closed emitted runtime import aliases')
  const inspect = (node) => {
    need(!(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      !(ts.isExportDeclaration(node) && node.moduleSpecifier), 'no hidden transport import')
    ts.forEachChild(node, inspect)
  }
  inspect(tree)
  const original = program.getSourceFile(row.path)
  need(original && Buffer.byteLength(original.text) <= 128 * 1024 && fs.realpathSync(row.path) === row.path &&
    fs.lstatSync(row.path).isFile() && fs.readFileSync(row.path, 'utf8') === original.text, 'transport source snapshot changed')
  fs.writeFileSync(path.join(root, basename), text, { flag: 'wx', mode: 0o600 })
  emitted.push(row.name)
  compiledTransport.push({ name: row.name, sourcePath: path.relative(process.cwd(), row.path), sourceSha256: hash(Buffer.from(original.text)),
    compiledSha256: hash(Buffer.from(text)), bytes: Buffer.byteLength(text), imports })
})
need(!result.emitSkipped && emitted.length === 3, 'actual storage and transport emit')
for (const [target, method] of [[klass, 'publicKey'], [httpClass, 'attemptHttp']]) {
  const member = target.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === method)
  need(member, 'actual declaration mutant member absent')
  const mutated = source.text.slice(0, member.getFullStart()) + source.text.slice(member.end)
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => path.resolve(name) === declaration
    ? ts.createSourceFile(name, mutated, languageVersion, true) : original(name, languageVersion, onError, shouldCreateNewSourceFile)
  const negative = ts.getPreEmitDiagnostics(ts.createProgram(inputs, options, host))
  need(negative.some((row) => row.code === 2339 && row.file?.fileName === abi && ts.flattenDiagnosticMessageText(row.messageText, ' ').includes(method)), 'declaration-removal mutant survived')
}
const gluePath = path.join(root, 'generated/kodera_rs.js')
const glue = fs.readFileSync(gluePath, 'utf8')
const glueAST = ts.createSourceFile(gluePath, glue, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const glueClass = glueAST.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'BrowserMlsDevice')
const exported = glueClass?.modifiers?.find((node) => node.kind === ts.SyntaxKind.ExportKeyword)
need(exported, 'actual generated class export absent')
const httpGlueClass = glueAST.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'BrowserMlsHttpDevice')
need(httpGlueClass?.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword), 'actual generated HTTP class export absent')
const mutantGlue = glue.slice(0, exported.getStart(glueAST)) + glue.slice(exported.end)
fs.writeFileSync(path.join(root, 'mutant-kodera_rs.js'), mutantGlue, { flag: 'wx', mode: 0o600 })
// Inspect the public module without instantiating it; worker creation remains
// the first execution of any native device operation.
const publicModule = new WebAssembly.Module(fs.readFileSync(path.join(root, 'generated/kodera_rs_bg.wasm')))
const receipt = { schema: 'wasm-device-abi-v1', actualModuleInventory,
  wasmImports: WebAssembly.Module.imports(publicModule), wasmExports: WebAssembly.Module.exports(publicModule), generatedDeclarationSha256: hash(Buffer.from(source.text)),
  storageSourceSha256: hash(Buffer.from(storageSource.text)), compiledStorageSha256: hash(fs.readFileSync(path.join(root, 'local-state.js'))),
  declarationMethods: methods, declarationRemovalMutantRefused: true,
  httpDeclarationMethods: httpMethods, httpDeclarationRemovalMutantRefused: true, compiledTransport,
  httpInventorySha256: hash(httpInventoryBytes), httpHostOracleOnly: true, httpFixtureSources,
  typescript: ts.version, playwright: '1.65.1', browserManifestSha256: hash(fs.readFileSync(browserManifest)), mutantGlueSha256: hash(Buffer.from(mutantGlue)) }
need(ts.version === '5.9.3', 'locked TypeScript version')
const receiptText = JSON.stringify(receipt) + '\n'
need(Buffer.byteLength(receiptText) <= 1024 * 1024, 'semantic receipt cap')
fs.writeFileSync(path.join(root, 'semantic-abi.json'), receiptText, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ status: 'semantic-abi-passed', declarationRemovalMutantRefused: true, httpDeclarationRemovalMutantRefused: true, httpHostOracleOnly: true }))
