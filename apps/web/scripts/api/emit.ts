// The three files the generator writes into `src/mocks/generated/`.
//
// Output is deterministic: same contract in, same bytes out, which is what the
// regeneration-is-clean gate compares against. These files are excluded from
// Prettier, so the formatting here is the formatting that ships.

import type { Operation, ProblemRow } from './spec.ts'

const HEADER = '// GENERATED FILE — DO NOT EDIT. Regenerate with: npm run api:generate\n'

/** Base path the mocks answer on. `*` so a handler matches whatever origin the app is built for. */
const MOCK_BASE = '*/api/v1'

const json = (value: unknown, indent = 2): string => JSON.stringify(value, null, indent)

const quote = (value: string): string => JSON.stringify(value)

/** `/domains/{domain_id}` is what the contract writes; `/domains/:domain_id` is what msw matches. */
export const toMswPath = (path: string): string => path.replace(/\{([^{}]+)\}/g, ':$1')

export function emitProblems(rows: ProblemRow[]): string {
  const lines: string[] = [
    HEADER,
    '// The closed registry of RFC 9457 problem types (contract `ProblemType`), with the',
    '// HTTP status each one is served with. Closed in both directions: a type outside',
    '// this list is a type the console has no message-catalogue key for, so nothing',
    '// may invent one. Adding a member upstream is a breaking change to this contract.',
    '',
    'export const PROBLEM_TYPES = [',
    ...rows.map((r) => `  ${quote(r.type)},`),
    '] as const',
    '',
    'export type ProblemType = (typeof PROBLEM_TYPES)[number]',
    '',
    'export const PROBLEM_STATUS: Readonly<Record<ProblemType, number>> = {',
    ...rows.map((r) => `  [${quote(r.type)}]: ${r.status},`),
    '}',
    '',
    '// Staff-facing prose from the contract, used to fill the `title` member a problem',
    '// document requires. It is never rendered to a customer: the console maps `type`',
    '// to a message-catalogue key (docs/dev/I18N.md).',
    'export const PROBLEM_TITLES: Readonly<Record<ProblemType, string>> = {',
    ...rows.map((r) => `  [${quote(r.type)}]: ${quote(r.title)},`),
    '}',
    '',
  ]
  return lines.join('\n')
}

/**
 * `src/mocks/generated/problems.ts`: a re-export, not a second copy. The registry is
 * contract knowledge, not mock knowledge — `src/api/client.ts` needs it to tell a
 * registered problem from an unregistered one, and that is production code reading
 * out of `src/mocks/` otherwise. The mocks import it from here exactly as before.
 */
export function emitProblemsReExport(): string {
  return [
    HEADER,
    '// The registry now lives in src/api/generated/problems.ts, next to the client that',
    '// needs it outside any mock. This file only re-exports it, so every existing import',
    "// of 'src/mocks/generated/problems' keeps working.",
    '',
    "export * from '../../api/generated/problems'",
    '',
  ].join('\n')
}

export function emitExamples(ops: Operation[]): string {
  const lines: string[] = [
    HEADER,
    '// One example response per operation, taken from the contract: the status and the',
    '// headers it declares, and the example body of its first 2xx response. List',
    '// envelopes are composed so `data` holds a row — the `CursorPage` example is an',
    '// empty page, and a mock that answered it would make every collection screen',
    '// render its empty state forever.',
    '',
    'export interface OperationExample {',
    '  readonly operationId: string',
    "  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete'",
    '  /** The contract path, still templated. */',
    '  readonly path: string',
    '  readonly status: number',
    '  readonly headers: Readonly<Record<string, string>>',
    '  /** The example body, or `null` where the contract declares no content. */',
    '  readonly body: unknown',
    '  /** Whether the body is a `CursorPage` envelope. */',
    '  readonly isList: boolean',
    '  /** Whether the operation requires an `Idempotency-Key` request header. */',
    '  readonly idempotent: boolean',
    '  /** Whether the operation requires an `If-Match` request header — every `PATCH` today. */',
    '  readonly requiresIfMatch: boolean',
    '  readonly conditionalWrite?: boolean',
    '}',
    '',
    'export const EXAMPLES = {',
  ]
  for (const op of ops) {
    lines.push(`  ${quote(op.operationId)}: {`)
    lines.push(`    operationId: ${quote(op.operationId)},`)
    lines.push(`    method: ${quote(op.method)},`)
    lines.push(`    path: ${quote(op.path)},`)
    lines.push(`    status: ${op.status},`)
    lines.push(`    headers: ${indentBody(json(op.headers))},`)
    lines.push(`    body: ${indentBody(json(op.body))},`)
    lines.push(`    isList: ${op.isList},`)
    lines.push(`    idempotent: ${op.idempotent},`)
    lines.push(`    requiresIfMatch: ${op.requiresIfMatch},`)
    if (op.conditionalWrite) lines.push(`    conditionalWrite: true,`)
    lines.push('  },')
  }
  lines.push('} satisfies Record<string, OperationExample>')
  lines.push('')
  lines.push('export type OperationId = keyof typeof EXAMPLES')
  lines.push('')
  return lines.join('\n')
}

/** Re-indents a JSON block so it sits under `    body: ` without a ragged left edge. */
function indentBody(block: string): string {
  const [first, ...rest] = block.split('\n')
  return [first, ...rest.map((line) => `    ${line}`)].join('\n')
}

export function emitHandlers(ops: Operation[], problemTypes: readonly string[]): string {
  const missingKey = problemTypes.find((t) => t.endsWith('/idempotency-key-missing'))
  if (!missingKey) throw new Error('The contract has no idempotency-key-missing problem type')

  // `precondition-required` is what the registry uses for "PATCH with no If-Match" — see
  // `docs/api/CONVENTIONS.md` §10. If a future contract dropped the type from the registry
  // while still requiring the header, the base handler falls back to answering the example
  // unchecked, and the client's own requirement to supply `concurrency` (a type error, not a
  // runtime one — see `src/api/mutations.ts`) is what a test would assert instead.
  const missingIfMatch = problemTypes.find((t) => t.endsWith('/precondition-required'))
  const needsIfMatch = ops.some((op) => op.requiresIfMatch)

  const lines: string[] = [
    HEADER,
    '// One msw handler per operation, answering the contract example. Hand-written base',
    '// responses are forbidden (docs/dev/TESTING.md): a mock written by hand keeps',
    '// passing against a shape the Core API stopped returning. Scenario overlays go in',
    '// `tests/e2e/scenarios/` and override these.',
    '',
    "import { http, HttpResponse } from 'msw'",
    "import type { HttpHandler } from 'msw'",
    "import type { components } from '@/api/schema'",
    "import { bindCurrentUserToMockRequest } from '../currentUserIdentity'",
    "import { EXAMPLES, type OperationExample } from './examples'",
    "import { PROBLEM_STATUS, PROBLEM_TITLES } from './problems'",
    '',
    '// `*` matches whatever origin the console is built against, so the same handlers',
    '// serve the unit suite, the Playwright build and a developer pointing at localhost.',
    `const BASE = ${quote(MOCK_BASE)}`,
    '',
    `const IDEMPOTENCY_KEY_MISSING = ${quote(missingKey)} as const`,
    ...(needsIfMatch && missingIfMatch
      ? [`const PRECONDITION_REQUIRED = ${quote(missingIfMatch)} as const`]
      : []),
    '',
    '// Every response of this API carries `X-Request-Id`, and it is the id a customer',
    '// quotes to support, so it is fresh per response rather than baked into the example.',
    'const requestId = (): string => crypto.randomUUID()',
    '',
    'interface Recorded {',
    '  readonly status: number',
    '  readonly body: unknown',
    '  readonly headers: Record<string, string>',
    '}',
    '',
    '// `(method, resolved path, key) → the first response`. A replay of a POST must',
    '// return what the first call returned; a retried order that creates a second one',
    '// is the failure `Idempotency-Key` exists to prevent. Per worker, and per process:',
    '// call `resetIdempotencyStore()` between tests that reuse a key.',
    'const recorded = new Map<string, Recorded>()',
    '',
    'export function resetIdempotencyStore(): void {',
    '  recorded.clear()',
    '}',
    '',
    'function send(status: number, body: unknown, headers: Record<string, string>): Response {',
    '  if (body === null) return new HttpResponse(null, { status, headers })',
    "  if (headers['Content-Type'] === 'text/plain' && typeof body === 'string') {",
    '    return HttpResponse.text(body, { status, headers })',
    '  }',
    '  return HttpResponse.json(body, { status, headers })',
    '}',
    '',
    'function answer(example: OperationExample): Response {',
    "  return send(example.status, example.body, { ...example.headers, 'X-Request-Id': requestId() })",
    '}',
    '',
    'function problemMissingHeader(type: string, request: Request): Response {',
    '  const id = requestId()',
    '  const status = PROBLEM_STATUS[type as keyof typeof PROBLEM_STATUS]',
    '  return HttpResponse.json(',
    '    {',
    '      type,',
    '      title: PROBLEM_TITLES[type as keyof typeof PROBLEM_TITLES],',
    '      status,',
    '      instance: new URL(request.url).pathname,',
    '      request_id: id,',
    '    },',
    '    {',
    '      status,',
    "      headers: { 'Content-Type': 'application/problem+json', 'X-Request-Id': id },",
    '    }',
    '  )',
    '}',
    '',
    'function answerIdempotent(example: OperationExample, request: Request): Response {',
    "  const key = request.headers.get('Idempotency-Key')",
    '  if (key === null) return problemMissingHeader(IDEMPOTENCY_KEY_MISSING, request)',
    '  const slot = `${request.method} ${new URL(request.url).pathname} ${key}`',
    '  const first = recorded.get(slot)',
    '  if (first !== undefined) {',
    "    return send(first.status, first.body, { ...first.headers, 'Idempotency-Replayed': 'true' })",
    '  }',
    "  const headers = { ...example.headers, 'X-Request-Id': requestId() }",
    '  recorded.set(slot, { status: example.status, body: example.body, headers })',
    '  return send(example.status, example.body, headers)',
    '}',
    '',
  ]

  if (needsIfMatch && missingIfMatch) {
    lines.push(
      '// A `PATCH` with no `If-Match` is refused by the contract itself (`428',
      '// precondition-required`), so the base handler enforces it the same way it enforces',
      "// `Idempotency-Key` on a POST — a mock that answered anyway would hide the client's",
      '// own bug behind a 200. A stale (mismatched) `If-Match` is not checked here: it needs',
      "// the resource's current tag, which a stateless example response does not carry.",
      'function answerRequiringIfMatch(example: OperationExample, request: Request): Response {',
      "  if (request.headers.get('If-Match') === null) {",
      '    return problemMissingHeader(PRECONDITION_REQUIRED, request)',
      '  }',
      '  return answer(example)',
      '}',
      ''
    )
  }

  if (ops.some((op) => op.conditionalWrite)) {
    lines.push(
      'function answerConditional(example: OperationExample, request: Request): Response {',
      "  const match = request.headers.get('If-Match')",
      "  const absent = request.headers.get('If-None-Match')",
      "  if (match === null && absent === null) return problemMissingHeader('https://kodera.io/problems/precondition-required', request)",
      "  if ((match !== null && absent !== null) || (absent !== null && absent !== '*') || match === '') return problemMissingHeader('https://kodera.io/problems/validation-error', request)",
      "  return answer(absent === '*' ? { ...example, status: 201 } : example)",
      '}',
      ''
    )
  }

  lines.push('export const handlers: HttpHandler[] = [')

  for (const op of ops) {
    const url = `\`\${BASE}${toMswPath(op.path)}\``
    const example = `EXAMPLES[${quote(op.operationId)}]`
    if (op.operationId === 'getMe') {
      lines.push(
        `  http.${op.method}(${url}, ({ request }) => answer({ ...${example}, body: bindCurrentUserToMockRequest(${example}.body as components['schemas']['Me'], request) })),`
      )
    } else if (op.idempotent) {
      lines.push(
        `  http.${op.method}(${url}, ({ request }) => answerIdempotent(${example}, request)),`
      )
    } else if (op.conditionalWrite) {
      lines.push(
        `  http.${op.method}(${url}, ({ request }) => answerConditional(${example}, request)),`
      )
    } else if (op.requiresIfMatch && needsIfMatch && missingIfMatch) {
      lines.push(
        `  http.${op.method}(${url}, ({ request }) => answerRequiringIfMatch(${example}, request)),`
      )
    } else {
      lines.push(`  http.${op.method}(${url}, () => answer(${example})),`)
    }
  }
  lines.push(']')
  lines.push('')
  return lines.join('\n')
}
