// The capability switch (`src/app/capabilities.ts`) is only as good as its table. This file reads
// every Core call the console makes, from the TypeScript syntax tree rather than a regular
// expression, maps each to the contract's operationId, and holds the table to what the code does:
//
// - every call to an operation of a capability Core does not serve sits in a module the table names
//   for it, so a new fetch written elsewhere fails here. This locates fetch functions, not the screens
//   that use their read hooks: those carry `enabled: offers(…)` themselves, which the pilot tests
//   (`src/app/capabilities.pilot.test.tsx`) prove send nothing. Writes have no such gate: they run
//   only from the hidden screens;
// - a call the collector cannot read (an aliased `coreApi()`, a `mutate()` whose route is not an
//   inline literal) fails here rather than being skipped;
// - every operation the staging walk found unrouted is either behind such a capability or no longer
//   called at all;
// - the table names no operation the contract lacks, and no caller that does not call it.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CAPABILITIES, type Capability } from '@/app/capabilities'

const root = join(import.meta.dirname, '..', '..', '..')
const src = join(root, 'src')
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

const spec = parse(readFileSync(join(root, 'contracts/core-api.openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string }>>
}
const operationOf = new Map<string, string>()
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const operationId = item[method]?.operationId
    if (operationId !== undefined) operationOf.set(`${method} ${path}`, operationId)
  }
}

// The operations Core does not route that the console called on console 5c0f45c0 and Core 37a5351
// (the staging walk's census), which the pilot hides or no longer calls. The seven others it found
// (dunning, slug availability, payment link, invoice download, help context, memberships count,
// support tickets) are being routed by Core for the pilot and are not this switch's business.
const UNROUTED_FOR_THE_PILOT = [
  'listEnrolmentTokens',
  'createEnrolmentToken',
  'revokeEnrolmentToken',
  'createMemberImport',
  'getMemberImport',
  'patchMemberImport',
  'executeMemberImport',
  'listStatusComponents',
  'listIncidents',
  'listTenantAvailability',
  'listDomains',
  'listEntitlements',
]

// `mutate()`'s own body sends the route it is given through `coreApi().request`; every route it
// sends is read at the `mutate({ method, path })` call sites instead.
const MUTATE_ITSELF = 'api/mutations.ts'

interface Call {
  file: string
  operationId: string
}

function stringOf(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined
}

/** `coreApi().GET('/path', …)` and `mutate({ method: 'post', path: '/path' }, …)`. */
export function callsIn(file: string, text: string): Call[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const calls: Call[] = []
  const record = (method: string, path: string, node: ts.Node) => {
    const operationId = operationOf.get(`${method.toLowerCase()} ${path}`)
    if (operationId === undefined) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      throw new Error(`${file}:${line + 1}: ${method} ${path} is not a contract operation`)
    }
    calls.push({ file, operationId })
  }
  const where = (node: ts.Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      // Every `coreApi()` must be read here: one held in a variable, or passed on, would call Core
      // where this collector cannot see it.
      if (ts.isIdentifier(callee) && callee.text === 'coreApi' && file !== MUTATE_ITSELF) {
        const access = node.parent
        const call = access.parent
        const read =
          ts.isPropertyAccessExpression(access) &&
          access.expression === node &&
          (METHODS as readonly string[]).includes(access.name.text.toLowerCase()) &&
          ts.isCallExpression(call) &&
          call.expression === access
        if (!read) throw new Error(`${where(node)}: a coreApi() not called as coreApi().VERB(path)`)
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isCallExpression(callee.expression) &&
        ts.isIdentifier(callee.expression.expression) &&
        callee.expression.expression.text === 'coreApi' &&
        (METHODS as readonly string[]).includes(callee.name.text.toLowerCase())
      ) {
        const path = stringOf(node.arguments[0])
        if (path === undefined)
          throw new Error(`${where(node)}: a coreApi() call with a computed path`)
        record(callee.name.text, path, node)
      } else if (ts.isIdentifier(callee) && callee.text === 'mutate') {
        const first = node.arguments[0]
        if (first === undefined || !ts.isObjectLiteralExpression(first))
          throw new Error(`${where(node)}: a mutate() whose route is not an inline object literal`)
        {
          const field = (name: string) => {
            const property = first.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name
            )
            return stringOf(property?.initializer)
          }
          const method = field('method')
          const path = field('path')
          if (method === undefined || path === undefined)
            throw new Error(`${where(node)}: a mutate() call with a computed method or path`)
          record(method, path, node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'mocks' ? [] : sources(path)
    if (!/\.tsx?$/.test(name) || /\.(test|stories)\.tsx?$/.test(name) || name.endsWith('.d.ts'))
      return []
    return [path]
  })
}

const consoleCalls: Call[] = sources(src).flatMap((path) =>
  callsIn(relative(src, path).split(sep).join('/'), readFileSync(path, 'utf8'))
)

const unserved = (
  Object.entries(CAPABILITIES) as [Capability, (typeof CAPABILITIES)[Capability]][]
).filter(([, row]) => !row.served)

/** Each call to an unserved operation outside the modules the table names for it. */
function strayCalls(calls: readonly Call[]): string[] {
  return unserved.flatMap(([capability, row]) =>
    calls
      .filter((call) => row.operations.includes(call.operationId as never))
      .filter((call) => !row.callers.includes(call.file))
      .map((call) => `${capability}: ${call.operationId} from ${call.file}`)
  )
}

describe('the capability switch', () => {
  it('reads the console’s calls (the collector sees a known one)', () => {
    expect(consoleCalls).toContainEqual({
      file: 'features/domain/queries.ts',
      operationId: 'listDomains',
    })
    expect(consoleCalls).toContainEqual({
      file: 'features/people/memberImport.ts',
      operationId: 'patchMemberImport',
    })
  })

  it('finds every unserved call only in a module the table names', () => {
    expect(strayCalls(consoleCalls)).toEqual([])
  })

  it('fails on a new caller of an unserved operation elsewhere (self-test)', () => {
    const fixture = callsIn(
      'features/home/NewCard.tsx',
      "coreApi().GET('/tenants/{tenant_id}/domains', {})\n" +
        "mutate({ method: 'post', path: '/organisations/{organisation_id}/enrolment-tokens' }, {})"
    )
    expect(strayCalls([...consoleCalls, ...fixture])).toEqual([
      'on-site-enrolment: createEnrolmentToken from features/home/NewCard.tsx',
      'domain-addresses: listDomains from features/home/NewCard.tsx',
    ])
  })

  it('refuses a call it cannot read rather than skip it (self-test)', () => {
    expect(() =>
      callsIn('a.ts', "const api = coreApi()\napi.GET('/tenants/{tenant_id}/domains', {})")
    ).toThrow('a.ts:1: a coreApi() not called as coreApi().VERB(path)')
    expect(() =>
      callsIn(
        'b.ts',
        "const ROUTE = { method: 'get', path: '/tenants/{tenant_id}/domains' }\nmutate(ROUTE, {})"
      )
    ).toThrow('b.ts:2: a mutate() whose route is not an inline object literal')
    expect(() => callsIn('c.ts', 'coreApi().GET(path, {})')).toThrow(
      'c.ts:1: a coreApi() call with a computed path'
    )
  })

  it('lists only operations the contract defines as found unrouted', () => {
    const known = new Set(operationOf.values())
    for (const id of UNROUTED_FOR_THE_PILOT) expect(known, id).toContain(id)
  })

  it('hides or drops every operation the staging walk found unrouted', () => {
    const hidden = new Set(unserved.flatMap(([, row]) => row.operations))
    const called = new Set(consoleCalls.map((call) => call.operationId))
    const exposed = UNROUTED_FOR_THE_PILOT.filter(
      (id) => called.has(id) && !hidden.has(id as never)
    )
    expect(exposed).toEqual([])
  })

  it('no longer calls the entitlements read, which had no screen', () => {
    expect(consoleCalls.filter((call) => call.operationId === 'listEntitlements')).toEqual([])
  })

  it('names only contract operations, and only callers that call them', () => {
    const known = new Set(operationOf.values())
    for (const [capability, row] of Object.entries(CAPABILITIES)) {
      for (const operationId of row.operations) expect(known, capability).toContain(operationId)
      for (const caller of row.callers) {
        const theirs = consoleCalls.filter(
          (call) => call.file === caller && row.operations.includes(call.operationId as never)
        )
        expect(theirs.length, `${capability}: ${caller}`).toBeGreaterThan(0)
      }
    }
  })
})

// Instant claim is resolved through the same canonical operation registry as every other route.
describe('the canonical instant-claim registration', () => {
  it('collects the one explicitly declared client operation', () => {
    expect(consoleCalls).toContainEqual({
      file: 'features/onboarding/instantClaimClient.ts',
      operationId: 'instantClaimWorkspace',
    })
  })
  it('does not admit an undeclared method, path or caller', () => {
    expect(() =>
      callsIn(
        'features/onboarding/instantClaimClient.ts',
        "coreApi().POST('/workspaces/unknown-claim', {})"
      )
    ).toThrow('not a contract operation')
    if (!operationOf.has('get /workspaces/instant-claim'))
      expect(() =>
        callsIn(
          'features/onboarding/instantClaimClient.ts',
          "coreApi().GET('/workspaces/instant-claim', {})"
        )
      ).toThrow('not a contract operation')
    if (!operationOf.has('post /workspaces/instant-claim'))
      expect(() =>
        callsIn('features/home/NewCard.tsx', "coreApi().POST('/workspaces/instant-claim', {})")
      ).toThrow('not a contract operation')
  })
})

it('matches every capability served flag to the server route manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, '../server/contracts/served-operations.json'), 'utf8')
  ) as {
    operations: { operation_id: string }[]
  }
  const served = new Set(manifest.operations.map((operation) => operation.operation_id))
  expect(served.size).toBeGreaterThan(0)
  for (const [name, row] of Object.entries(CAPABILITIES)) {
    expect(row.operations.length, name).toBeGreaterThan(0)
    expect(row.served, name).toBe(row.operations.every((operation) => served.has(operation)))
  }
})
