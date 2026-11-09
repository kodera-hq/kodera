// `npm run api:generate`.
//
// Turns the pinned contract into the four artefacts the console builds against:
// the TypeScript types, one example response per operation, the msw base handlers,
// and the problem registry. Everything downstream of this script is generated, so
// the console cannot quietly disagree with the API it is a client of.
//
// Node 22 runs this file directly (built-in type stripping): `node scripts/api/generate.ts`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import openapiTS, { astToString } from 'openapi-typescript'
import { emitExamples, emitHandlers, emitProblems, emitProblemsReExport } from './emit.ts'
import { ContractError, operations, problems, readPinnedSpec } from './spec.ts'
import type { Operation, Spec } from './spec.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

export interface GenerateOptions {
  contract: string
  lock: string
  /** Root the four artefacts are written under. Defaults to the repository. */
  out: string
}

export interface GenerateResult {
  version: string
  operations: number
  listOperations: number
  schemas: number
  problemTypes: number
  /** Contract observations worth reporting upstream. Never a reason to patch locally. */
  notes: string[]
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

/**
 * The organisation a caller belongs to, per `GET /me`, has to be an organisation
 * `GET /organisations` can return. Two examples that disagree make every screen
 * that resolves a slug to an id look correct in the mocks and fail against the API.
 * Reported, never patched: the examples belong to the contract.
 */
function checkOrganisationCoherence(ops: Operation[], notes: string[]): void {
  const me = ops.find((o) => o.operationId === 'getMe')
  const list = ops.find((o) => o.operationId === 'listOrganisations')
  if (!me || !list) {
    notes.push('getMe or listOrganisations is missing, so their examples could not be compared.')
    return
  }
  const meBody = me.body as { organisations?: { organisation?: { id?: string } }[] } | null
  const listBody = list.body as { data?: { id?: string }[] } | null
  const referenced = (meBody?.organisations ?? []).map((m) => m.organisation?.id).filter(Boolean)
  const available = new Set((listBody?.data ?? []).map((o) => o.id).filter(Boolean))
  for (const id of referenced) {
    if (!available.has(id as string)) {
      notes.push(
        `getMe references organisation ${id as string}, which the listOrganisations example does not contain. ` +
          'A console that resolves a slug to an id through GET /me will not find it in the collection.'
      )
    }
  }
  // A silent pass and a check that never ran again look identical from the CLI output
  // alone. Printing the count on every run is what tells the two apart.
  notes.push(`coherence check: compared ${referenced.length} ids.`)
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const spec: Spec = readPinnedSpec(options.contract, options.lock)

  const ast = await openapiTS(pathToFileURL(resolve(options.contract)), {
    // The contract is the source of truth for what is optional; nothing here
    // second-guesses it, so no `defaultNonNullable` or `emptyObjectsUnknown`.
    alphabetize: false,
  })
  const types = astToString(ast)

  const ops = operations(spec)
  const rows = problems(spec)

  const notes: string[] = []
  checkOrganisationCoherence(ops, notes)
  const headerless = ops.filter((o) => o.headers['X-Request-Id'] === undefined)
  if (headerless.length > 0) {
    notes.push(
      `No X-Request-Id example on the first 2xx of: ${headerless.map((o) => o.operationId).join(', ')}`
    )
  }

  write(
    join(options.out, 'src', 'api', 'schema.d.ts'),
    `// GENERATED FILE — DO NOT EDIT. Regenerate with: npm run api:generate\n${types}`
  )
  write(join(options.out, 'src', 'api', 'generated', 'problems.ts'), emitProblems(rows))
  write(join(options.out, 'src', 'mocks', 'generated', 'problems.ts'), emitProblemsReExport())
  write(join(options.out, 'src', 'mocks', 'generated', 'examples.ts'), emitExamples(ops))
  write(
    join(options.out, 'src', 'mocks', 'generated', 'handlers.ts'),
    emitHandlers(
      ops,
      rows.map((r) => r.type)
    )
  )

  return {
    version: spec.info.version,
    operations: ops.length,
    listOperations: ops.filter((o) => o.isList).length,
    schemas: Object.keys(spec.components.schemas).length,
    problemTypes: rows.length,
    notes,
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      contract: { type: 'string' },
      lock: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const at = (value: string | undefined, fallback: string): string =>
    value === undefined ? join(REPO_ROOT, fallback) : isAbsolute(value) ? value : resolve(value)

  const options: GenerateOptions = {
    contract: at(values.contract, 'contracts/core-api.openapi.yaml'),
    lock: at(values.lock, 'contracts/contract.lock.json'),
    out: at(values.out, '.'),
  }

  const result = await generate(options)
  process.stdout.write(
    `Core API contract ${result.version}: ${result.operations} operations ` +
      `(${result.listOperations} collections), ${result.schemas} schemas, ` +
      `${result.problemTypes} problem types.\n`
  )
  for (const note of result.notes) process.stdout.write(`  contract note: ${note}\n`)
}

// Only when run as a program. The tests import `generate` directly.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof ContractError ? error.message : String(error)
    process.stderr.write(`api:generate failed: ${message}\n`)
    process.exit(1)
  }
}
