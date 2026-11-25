import { stripTypeScriptTypes } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
const source = await readFile(new URL('./src/cli.ts', import.meta.url), 'utf8')
await mkdir(new URL('./runtime/', import.meta.url), { recursive: true })
await writeFile(
  new URL('./runtime/cli.mjs', import.meta.url),
  stripTypeScriptTypes(source, { mode: 'strip' }).replace(/[\t ]+$/gmu, ''),
)
