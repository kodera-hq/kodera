// Parse source only. Never import or execute a test module or its fixtures.
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function qualifiedName(node) {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node))
    return `${qualifiedName(node.expression)}.${node.name.text}`
  return ''
}

const names = new Set()
const notices = []
try {
  const files = JSON.parse(readFileSync(0, 'utf8'))
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    if (source.parseDiagnostics.length > 0) throw new Error(`${file}: invalid TypeScript`)
    function visit(node, inactive = false) {
      let childInactive = inactive
      if (ts.isCallExpression(node)) {
        const call = qualifiedName(node.expression)
        if (call === 'test.describe.skip' || call === 'test.describe.fixme') childInactive = true
        if (['test', 'test.only', 'test.skip', 'test.fixme'].includes(call)) {
          const title = node.arguments[0]
          const body = node.arguments.at(-1)
          const literal =
            title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
          const callback = body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))
          if (inactive || call === 'test.skip' || call === 'test.fixme') {
            notices.push(`${file}: inactive declaration${literal ? `: ${title.text}` : ''}`)
          } else if (!literal || !callback) {
            notices.push(`${file}: unresolved title or callback`)
          } else {
            names.add(title.text)
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, childInactive))
    }
    visit(source)
  }
  process.stdout.write(JSON.stringify({ names: [...names], notices }))
} catch (error) {
  process.stderr.write(`source scan failed: ${error.message}\n`)
  process.exitCode = 1
}
