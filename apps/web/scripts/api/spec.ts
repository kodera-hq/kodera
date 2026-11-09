// Reading the pinned contract: the lock check, and the rules that turn a schema
// into the one example the mocks answer with.
//
// Nothing here invents a value. Every byte of every mock response comes from an
// `examples` member the contract already carries, because a hand-written base
// response is exactly how a mock drifts from the API it stands for
// (docs/dev/TESTING.md). A schema with no example is a bug in the contract and
// is reported upstream, never patched here.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

export type Json = unknown
export type JsonObject = Record<string, unknown>

/** The subset of the document this generator reads. Everything else is passed to openapi-typescript. */
export interface Spec extends JsonObject {
  openapi: string
  info: { version: string; [k: string]: unknown }
  paths: Record<string, JsonObject>
  components: { schemas: Record<string, JsonObject>; [k: string]: unknown }
}

/** The verbs the contract uses. `PUT` does not exist in this API (CONSOLE_RECONCILIATION §4.6). */
export const METHODS = ['get', 'post', 'patch', 'delete'] as const
export type Method = (typeof METHODS)[number]

export interface Operation {
  operationId: string
  method: Method
  /** The contract path, still templated: `/organisations/{organisation_id}`. */
  path: string
  status: number
  /** Response headers the contract declares AND gives an example for. */
  headers: Record<string, string>
  /** The example body, or `null` for a response the contract declares with no content. */
  body: Json
  /** True when the response is a `CursorPage` envelope, which the mocks must not answer empty. */
  isList: boolean
  /** True when the operation requires an `Idempotency-Key` request header. */
  idempotent: boolean
  /** True when the operation requires an `If-Match` request header — every `PATCH` today. */
  requiresIfMatch: boolean
}

/** A contract bug: something the mocks need and the contract does not carry. Never patched locally. */
export class ContractError extends Error {}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface Lock {
  repository: string
  ref: string
  path: string
  version: string
  sha256: string
}

/**
 * Reads the contract and refuses to go on unless it is byte-for-byte the file the
 * lock names. An edited local copy is the failure this guards: it would generate a
 * client for an API nobody runs, and every test in the repository would agree with it.
 */
export function readPinnedSpec(contractPath: string, lockPath: string): Spec {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lock
  const bytes = readFileSync(contractPath)
  const actual = sha256(bytes)
  if (actual !== lock.sha256) {
    throw new ContractError(
      `${contractPath} does not match ${lockPath}: expected sha256 ${lock.sha256}, found ${actual}. ` +
        'The contract is a verbatim copy and is never edited here — restore it, or bump the lock deliberately.'
    )
  }
  const spec = parseYaml(bytes.toString('utf8')) as Spec
  if (spec.info.version !== lock.version) {
    throw new ContractError(
      `${contractPath} declares info.version ${spec.info.version}, ${lockPath} records ${lock.version}.`
    )
  }
  return spec
}

function deref(spec: Spec, ref: string): JsonObject {
  if (!ref.startsWith('#/')) throw new ContractError(`Only local refs are supported, found ${ref}`)
  let node: unknown = spec
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (typeof node !== 'object' || node === null)
      throw new ContractError(`Unresolvable ref ${ref}`)
    node = (node as JsonObject)[key]
  }
  if (typeof node !== 'object' || node === null) throw new ContractError(`Unresolvable ref ${ref}`)
  return node as JsonObject
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function hasType(schema: JsonObject, name: string): boolean {
  const t = schema['type']
  return t === name || (Array.isArray(t) && t.includes(name))
}

/**
 * Which example a schema that carries several stands for, named and recognised by
 * what it says rather than by where it sits in the list.
 *
 * Taking `examples[0]` from such a schema makes the order of the contract's list a
 * decision about the console's base mocks: a reorder upstream would silently swap
 * every screen's default answer — "no organisation" for "one organisation" — with
 * the regeneration check still green, since it only compares the output with
 * itself. Here the choice is the console's, written down: `matches` must pick out
 * exactly one example, and a schema with more than one example and no entry here
 * stops the generator. `tests/unit/api/example-choices.test.ts` holds each entry to
 * the pinned contract, so an entry left behind by a contract change fails too.
 */
export interface ExampleChoice {
  /** What the chosen example stands for, as the specs and overlays name it. */
  name: string
  matches: (example: Json) => boolean
}

export const EXAMPLE_CHOICES: Readonly<Record<string, ExampleChoice>> = {
  // docs/specs/00-shell-and-login.md §7: the base answer is the neutral zero result;
  // a spec that means "one organisation" names `login.single-organisation`, and
  // "two organisations" names `login.two-organisations`.
  RealmDiscoveryResult: {
    name: 'zero',
    matches: (example) => {
      const value = asObject(example)
      return (
        value !== undefined &&
        value['realm'] === null &&
        Array.isArray(value['candidates']) &&
        value['candidates'].length === 0
      )
    },
  },
  // The base answer is the starter workspace, `initialised`, as it has been since the
  // workspace page landed; the not-yet-created states are the `workspace.*` overlays.
  Workspace: {
    name: 'initialised',
    matches: (example) => asObject(example)?.['state'] === 'initialised',
  },
  // The current server omits caller assurance; where a schema does reach it, the base
  // answer is the minimal one, which carries no enrollment evidence.
  BootstrapCallerAssurance: {
    name: 'minimal-enrollment-unknown',
    matches: (example) => {
      const value = asObject(example)
      return value !== undefined && !('enrollment_window' in value)
    },
  },
}

function chosenExample(
  examples: readonly Json[],
  schemaName: string | undefined,
  trail: string,
  choices: Readonly<Record<string, ExampleChoice>>
): Json {
  if (examples.length === 1) return examples[0]
  const choice = schemaName === undefined ? undefined : choices[schemaName]
  if (!choice) {
    throw new ContractError(
      `${trail}: ${examples.length} examples and no named choice for ` +
        `${schemaName ?? 'this inline schema'}. Taking the first would let a reorder in the contract ` +
        'change the base mock silently; name the intended one in EXAMPLE_CHOICES (scripts/api/spec.ts).'
    )
  }
  const matching = examples.filter((example) => choice.matches(example))
  if (matching.length !== 1) {
    throw new ContractError(
      `${trail}: the "${choice.name}" example of ${schemaName as string} matches ` +
        `${matching.length} of its ${examples.length} examples, not exactly one. The contract's ` +
        'examples changed; decide again which one the base mock answers with.'
    )
  }
  return matching[0]
}

/**
 * The one example this schema stands for.
 *
 * A schema's own example wins wherever the contract carries one: the only one, or —
 * where it carries several — the one `EXAMPLE_CHOICES` names. Where it carries none
 * — the anonymous object inside a list envelope's `allOf` — the example is composed
 * from the members, which is how `{data: []}` on `CursorPage` becomes a page with a
 * row in it rather than an empty list every screen would render as its empty state.
 */
export function exampleOf(
  spec: Spec,
  schema: JsonObject,
  trail: string,
  schemaName?: string,
  choices: Readonly<Record<string, ExampleChoice>> = EXAMPLE_CHOICES
): Json {
  const ref = schema['$ref']
  if (typeof ref === 'string') {
    const name = ref.slice(ref.lastIndexOf('/') + 1)
    return exampleOf(spec, deref(spec, ref), `${trail} → ${name}`, name, choices)
  }

  // A schema's own example always wins, including on an `allOf` that carries one:
  // the contract has already written the composed value there.
  const examples = schema['examples']
  if (Array.isArray(examples) && examples.length > 0) {
    return structuredClone(chosenExample(examples, schemaName, trail, choices)) as Json
  }

  const allOf = schema['allOf']
  if (Array.isArray(allOf)) {
    let merged: JsonObject = {}
    for (const [i, member] of allOf.entries()) {
      const part = asObject(member)
      if (!part) throw new ContractError(`${trail}: allOf[${i}] is not a schema`)
      const value = exampleOf(spec, part, `${trail} → allOf[${i}]`, undefined, choices)
      const asObj = asObject(value)
      if (!asObj) throw new ContractError(`${trail}: allOf[${i}] does not compose to an object`)
      merged = { ...merged, ...asObj }
    }
    return merged
  }

  // No example of its own: compose one from the members that have one. This is the
  // only branch that builds a value, and it builds it out of the contract's own
  // examples — it never picks a string or a number.
  if (hasType(schema, 'array') || schema['items'] !== undefined) {
    const items = asObject(schema['items'])
    if (!items || Object.keys(items).length === 0) return []
    return [exampleOf(spec, items, `${trail}[]`, undefined, choices)]
  }

  const properties = asObject(schema['properties'])
  if (properties) {
    const out: JsonObject = {}
    for (const [name, value] of Object.entries(properties)) {
      const prop = asObject(value)
      if (!prop) continue
      out[name] = exampleOf(spec, prop, `${trail}.${name}`, undefined, choices)
    }
    return out
  }

  throw new ContractError(
    `${trail}: no example. Every schema in this contract must carry one — the examples are the mocks ` +
      '(contracts/README.md in kodera-server). Report it upstream; do not add one here.'
  )
}

function isCursorPage(schema: JsonObject): boolean {
  const allOf = schema['allOf']
  if (!Array.isArray(allOf)) return false
  return allOf.some((m) => asObject(m)?.['$ref'] === '#/components/schemas/CursorPage')
}

/**
 * A response header's example, wherever the contract put it.
 *
 * A Header Object carries its example the way a Parameter Object does — `example`
 * (one value) or `examples` (a map of Example Objects) — not the way a schema does.
 * Every `Location` header in this contract uses the singular `example` field with a
 * bare `schema: { type: string, ... }` that carries none of its own, so a reader that
 * only looks at `schema.examples` finds every one of them empty. `schema.examples` is
 * still checked first: a header whose schema is a shared, exampled component (none
 * today) should not be shadowed by a header-level omission.
 */
function headerExampleOf(spec: Spec, resolved: JsonObject): string | undefined {
  const schema = asObject(resolved['schema'])
  const schemaExamples = schema?.['examples']
  if (Array.isArray(schemaExamples) && schemaExamples.length > 0) {
    return String(schemaExamples[0])
  }

  if ('example' in resolved) return String(resolved['example'])

  const examples = asObject(resolved['examples'])
  if (examples) {
    const [first] = Object.values(examples)
    const example = asObject(first)
    if (example) {
      const resolvedExample = example['$ref'] ? deref(spec, example['$ref'] as string) : example
      if ('value' in resolvedExample) return String(resolvedExample['value'])
    }
  }

  return undefined
}

function plainExampleOf(
  spec: Spec,
  plain: JsonObject,
  operationId: string,
  choices: Readonly<Record<string, ExampleChoice>>
): string {
  const plainSchema = asObject(plain['schema'])
  const value =
    'example' in plain
      ? plain['example']
      : plainSchema
        ? exampleOf(spec, plainSchema, operationId, undefined, choices)
        : undefined
  if (typeof value === 'string' && value.length > 0) return value
  throw new ContractError(
    `${operationId}: no string example. Every text/plain response in this contract must carry one — the examples are the mocks ` +
      '(contracts/README.md in kodera-server). Report it upstream; do not add one here.'
  )
}

/** Every operation the contract declares, each with the example its mock answers with. */
export function operations(
  spec: Spec,
  choices: Readonly<Record<string, ExampleChoice>> = EXAMPLE_CHOICES
): Operation[] {
  const out: Operation[] = []
  for (const [path, itemRaw] of Object.entries(spec.paths)) {
    const item = asObject(itemRaw)
    if (!item) continue
    const shared = Array.isArray(item['parameters']) ? item['parameters'] : []
    for (const method of METHODS) {
      const op = asObject(item[method])
      if (!op) continue
      const operationId = op['operationId']
      if (typeof operationId !== 'string') {
        throw new ContractError(`${method.toUpperCase()} ${path}: no operationId`)
      }
      const responses = asObject(op['responses'])
      if (!responses) throw new ContractError(`${operationId}: no responses`)
      const success = Object.keys(responses)
        .filter((code) => code.startsWith('2'))
        .sort()[0]
      if (!success) throw new ContractError(`${operationId}: no 2xx response`)
      const responseRaw = asObject(responses[success])
      if (!responseRaw)
        throw new ContractError(`${operationId}: response ${success} is not an object`)
      // A 2xx response written as `$ref` (a shared success response, not yet used today but
      // legal OpenAPI) must be resolved before its `content` and `headers` are readable —
      // reading `content` straight off the `{ $ref }` object finds nothing and would silently
      // mock a body-less response for an operation that has one.
      const response = responseRaw['$ref']
        ? deref(spec, responseRaw['$ref'] as string)
        : responseRaw

      const content = asObject(response['content'])
      const json = content ? asObject(content['application/json']) : undefined
      const plain = content ? asObject(content['text/plain']) : undefined
      const schema = json ? asObject(json['schema']) : undefined
      if (json && !schema) {
        throw new ContractError(`${operationId}: application/json response carries no schema`)
      }

      const headers: Record<string, string> = {}
      if (plain && !json) headers['Content-Type'] = 'text/plain'
      for (const [name, valueRaw] of Object.entries(asObject(response['headers']) ?? {})) {
        const header = asObject(valueRaw)
        const resolved = header?.['$ref'] ? deref(spec, header['$ref'] as string) : header
        // A header the contract declares with no example anywhere — on its schema, or
        // as `example`/`examples` on the header itself — cannot be mocked without
        // making a value up, so it is left off.
        const example = resolved ? headerExampleOf(spec, resolved) : undefined
        if (example !== undefined) headers[name] = example
      }

      const parameters = [...shared, ...(Array.isArray(op['parameters']) ? op['parameters'] : [])]
      const hasHeaderParam = (headerName: string, requiredOnly = false): boolean =>
        parameters.some((p) => {
          const param = asObject(p)
          if (!param) return false
          const resolved = param['$ref'] ? deref(spec, param['$ref'] as string) : param
          return resolved['name'] === headerName && (!requiredOnly || resolved['required'] === true)
        })

      const body = schema
        ? exampleOf(spec, schema, operationId, undefined, choices)
        : plain
          ? plainExampleOf(spec, plain, operationId, choices)
          : null

      out.push({
        operationId,
        method,
        path,
        status: Number(success),
        headers,
        body,
        isList: schema ? isCursorPage(schema) : false,
        idempotent: hasHeaderParam('Idempotency-Key'),
        // Only a required one: a removal's `If-Match` is optional, enforced when present.
        requiresIfMatch: hasHeaderParam('If-Match', true),
      })
    }
  }
  return out
}

export interface ProblemRow {
  type: string
  status: number
  title: string
}

/**
 * The problem registry, read out of `ProblemType`: the enum is the closed list of
 * URIs, the markdown table in its description is where each one's status lives.
 * Both are parsed, and they have to agree — a URI in one and not the other is a
 * contract bug, and the console would map it to no message key at all.
 */
export function problems(spec: Spec): ProblemRow[] {
  const problemType = spec.components.schemas['ProblemType']
  if (!problemType) throw new ContractError('components.schemas.ProblemType is missing')
  const uris = problemType['enum']
  if (!Array.isArray(uris)) throw new ContractError('ProblemType carries no enum')
  const description = String(problemType['description'] ?? '')

  const table = new Map<string, { status: number; title: string }>()
  for (const line of description.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    // `| \`slug\` | 400 | when | what the client should do |` — five cells with the
    // empty ones the leading and trailing pipes produce.
    if (cells.length < 5) continue
    const slug = /^`([a-z-]+)`$/.exec(cells[1] ?? '')?.[1]
    const status = Number(cells[2])
    if (!slug || !Number.isInteger(status)) continue
    // cells[3] is "When" — the triggering condition, e.g. "body failed schema or business
    // validation" — not a title. cells[4], "What the client should do", is prose a caller
    // can show as-is when nothing more specific is at hand.
    table.set(slug, { status, title: cells[4] ?? '' })
  }

  const rows: ProblemRow[] = []
  for (const uri of uris) {
    const type = String(uri)
    const slug = type.slice(type.lastIndexOf('/') + 1)
    const row = table.get(slug)
    if (!row) {
      throw new ContractError(
        `ProblemType ${type} has no row in the registry table in its own description, so its HTTP status is unknown.`
      )
    }
    rows.push({ type, status: row.status, title: row.title })
    table.delete(slug)
  }
  if (table.size > 0) {
    throw new ContractError(
      `The ProblemType table documents ${[...table.keys()].join(', ')}, which the enum does not contain.`
    )
  }
  return rows
}
