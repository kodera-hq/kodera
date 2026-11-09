import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  buildLlmsText,
  documentationPages,
  exportDocumentationPage,
} from '../src/features/docs/documentationExport.ts'
const destination = fileURLToPath(new URL('../public/', import.meta.url))
const check = process.argv.slice(2).includes('--check')
const files = [['llms.txt', buildLlmsText()]]
for (const locale of ['en', 'fr']) {
  for (const page of documentationPages(locale))
    files.push([`developer-docs/${locale}/${page.id}.md`, exportDocumentationPage(page)])
}
for (const [name, body] of files) {
  const path = join(destination, name)
  if (check) {
    if ((await readFile(path, 'utf8')) !== body)
      throw new Error(`Documentation artifact differs: ${name}`)
  } else {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, body)
  }
}
console.log(`${check ? 'Checked' : 'Generated'} ${files.length} public documentation files`)
