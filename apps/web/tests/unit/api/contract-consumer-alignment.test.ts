// Hosted Typecheck includes tests/unit through tsconfig.node.json. These runtime
// compiler checks additionally execute the in-memory declaration mutations.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { http } from 'msw'
import ts from 'typescript'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { ApiProblem, coreApi, setTokenProvider } from '@/api/client'
import { channelRoomAlias } from '@/features/espace/homeserver'
import { PROBLEM_TITLES, PROBLEM_TYPES } from '@/api/generated/problems'
import { EXAMPLES } from '@/mocks/generated/examples'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { server } from '@/mocks/server'
import { operations, problems } from '../../../scripts/api/spec.ts'
import type { Spec } from '../../../scripts/api/spec.ts'

const root = join(import.meta.dirname, '..', '..', '..')
const raw = readFileSync(join(root, 'contracts/core-api.openapi.yaml'))
const spec = parse(raw.toString('utf8')) as Spec
const lock: unknown = JSON.parse(readFileSync(join(root, 'contracts/contract.lock.json'), 'utf8'))
const schema = readFileSync(join(root, 'src/api/schema.d.ts'), 'utf8')
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const contactType = 'https://kodera.io/problems/owner-claim-contact-unverified'
const serviceType = 'https://kodera.io/problems/service-unavailable'
const expectedLock = {
  repository: 'kodera-hq/kodera',
  ref: 'e27efd630ab6edfffb6e8a5c28a0cb9d96c443c0',
  commit: 'e27efd630ab6edfffb6e8a5c28a0cb9d96c443c0',
  path: 'packages/api-contract/core-api.openapi.yaml',
  version: '0.44.0',
  sha256: 'be235a9b870d251fd4114c464d8a10580b34d11f4390903cacac7cea82128cda',
}

function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}

function object(value: unknown): Record<string, unknown> {
  requireThat(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'object required'
  )
  return value as Record<string, unknown>
}

function checkPin(document: Spec, metadata: unknown, bytes: Buffer) {
  requireThat(
    JSON.stringify(metadata) === JSON.stringify(expectedLock),
    'immutable lock provenance'
  )
  requireThat(document.info.version === expectedLock.version, 'immutable contract version')
  requireThat(sha(bytes) === expectedLock.sha256, 'immutable contract bytes')
}

function consumeResponses(document: Spec) {
  const post = object(document.paths['/owner-claims/actions/consume']?.['post'])
  requireThat(post['operationId'] === 'consumeOwnerClaim', 'consume operation identity')
  return object(post['responses'])
}

function checkTransient(document: Spec) {
  const response = consumeResponses(document)['503']
  requireThat(response !== undefined, 'consume503 response required')
  const headers = object(object(response)['headers'])
  requireThat(object(object(headers['Retry-After'])['schema'])['const'] === 1, 'retry literal one')
  requireThat(
    object(object(headers['Cache-Control'])['schema'])['const'] === 'no-store',
    'transient no-store'
  )
  const body = object(object(object(response)['content'])['application/problem+json'])
  requireThat(
    object(body['schema'])['$ref'] === '#/components/schemas/Problem',
    'registered Problem'
  )
}

function checkGuidance(document: Spec) {
  const description = document.components.schemas['ProblemType']?.['description']
  requireThat(typeof description === 'string', 'ProblemType registry description')
  const line = description
    .split('\n')
    .find((row) => row.includes('| `owner-claim-contact-unverified` |'))
  requireThat(line?.includes('retry with a new logical key'), 'contact new logical key')
}

function createOrganisationResponses(document: Spec) {
  const post = object(document.paths['/organisations']?.['post'])
  requireThat(post['operationId'] === 'createOrganisation', 'create organisation identity')
  return object(post['responses'])
}

function operationReferenceHeader(document: Spec, status: '201' | '409') {
  const response = object(createOrganisationResponses(document)[status])
  return object(object(response['headers'])['X-Operation-Ref'])
}

function checkOperationReference(document: Spec) {
  const success = operationReferenceHeader(document, '201')
  requireThat(success['required'] === true, '201 operation reference required')
  requireThat(
    object(success['schema'])['$ref'] === '#/components/schemas/OperationReference',
    '201 operation reference schema'
  )

  const conflict = operationReferenceHeader(document, '409')
  requireThat(conflict['required'] === false, '409 operation reference optional')
  requireThat(
    object(conflict['schema'])['$ref'] === '#/components/schemas/OperationReference',
    '409 operation reference schema'
  )

  const reference = object(document.components.schemas['OperationReference'])
  requireThat(reference['type'] === 'string', 'operation reference string')
  requireThat(
    reference['pattern'] === '^[0-9a-f]{64}(?![\\s\\S])',
    'strict operation reference pattern'
  )
  const pattern = new RegExp(String(reference['pattern']))
  requireThat(pattern.test('a'.repeat(64)), 'operation reference accepts lowercase hexadecimal')
  requireThat(!pattern.test('A'.repeat(64)), 'operation reference rejects uppercase hexadecimal')
  requireThat(!pattern.test(`${'a'.repeat(64)}\n`), 'operation reference rejects trailing newline')
}

function checkMfaEnrollmentSemantics(document: Spec) {
  const identity = object(document.components.schemas['Identity'])
  const required = identity['required']
  requireThat(Array.isArray(required), 'Identity required list')
  requireThat(!required.includes('mfa_enrolled'), 'MFA enrollment optional')
  const enrollment = object(object(identity['properties'])['mfa_enrolled'])
  requireThat(enrollment['type'] === 'boolean', 'MFA enrollment strict boolean')
  requireThat(!('default' in enrollment), 'MFA enrollment has no default')
  const description = enrollment['description']
  requireThat(typeof description === 'string', 'MFA enrollment description')
  requireThat(description.includes('signed local-TOTP registration fact'), 'local TOTP enrollment')
  requireThat(description.includes('strict `false` means'), 'strict false enrollment semantics')
  requireThat(description.includes('omission means unknown'), 'omission enrollment semantics')
}

describe('the immutable contract consumer', () => {
  it('binds exact tagged bytes and the existing six provenance fields', () =>
    checkPin(spec, lock, raw))

  it.each(['ref', 'commit', 'sha256', 'version', 'repository', 'path'])(
    'refuses a changed or missing immutable %s without hiding behind a type cast',
    (field) => {
      checkPin(spec, lock, raw)
      const changed = { ...object(lock), [field]: `${String(object(lock)[field])}-changed` }
      expect(() => checkPin(spec, changed, raw)).toThrow('immutable lock provenance')
      const missing = { ...object(lock) }
      delete missing[field]
      expect(() => checkPin(spec, missing, raw)).toThrow('immutable lock provenance')
    }
  )

  it('refuses a changed document version or byte without changing the lock', () => {
    checkPin(spec, lock, raw)
    const changed = structuredClone(spec)
    changed.info.version = '0.15.0'
    expect(() => checkPin(changed, lock, raw)).toThrow('immutable contract version')
    expect(() => checkPin(spec, lock, Buffer.concat([raw, Buffer.from('\n')]))).toThrow(
      'immutable contract bytes'
    )
  })

  it('declares the bounded, nonstored transient response and contact new-key recovery', () => {
    checkTransient(spec)
    checkGuidance(spec)
    expect(PROBLEM_TITLES[contactType]).toContain('retry with a new logical key')
  })

  it('requires one strict operation reference on create success and keeps conflict conditional', () => {
    checkOperationReference(spec)
  })

  it.each(['optional-201', 'required-409', 'wide-pattern', 'newline-pattern'] as const)(
    'refuses the isolated %s operation-reference mutation',
    (mutation) => {
      checkOperationReference(spec)
      const changed = structuredClone(spec)
      if (mutation === 'optional-201') operationReferenceHeader(changed, '201')['required'] = false
      else if (mutation === 'required-409')
        operationReferenceHeader(changed, '409')['required'] = true
      else {
        const reference = object(changed.components.schemas['OperationReference'])
        reference['pattern'] = mutation === 'wide-pattern' ? '^[0-9A-Fa-f]{64}$' : '^[0-9a-f]{64}$'
      }
      const reason = {
        'optional-201': '201 operation reference required',
        'required-409': '409 operation reference optional',
        'wide-pattern': 'strict operation reference pattern',
        'newline-pattern': 'strict operation reference pattern',
      }[mutation]
      expect(() => checkOperationReference(changed)).toThrow(reason)
    }
  )

  it('records local TOTP enrollment while preserving false and omission as distinct states', () => {
    checkMfaEnrollmentSemantics(spec)
  })

  it.each([
    'required-mfa',
    'default-false',
    'nullable-type',
    'local-totp',
    'strict-false',
    'omission',
  ] as const)('refuses the isolated %s MFA semantic mutation', (mutation) => {
    checkMfaEnrollmentSemantics(spec)
    const changed = structuredClone(spec)
    const identity = object(changed.components.schemas['Identity'])
    const enrollment = object(object(identity['properties'])['mfa_enrolled'])
    if (mutation === 'required-mfa') {
      const required = identity['required']
      requireThat(Array.isArray(required), 'Identity required list')
      required.push('mfa_enrolled')
    } else if (mutation === 'default-false') enrollment['default'] = false
    else if (mutation === 'nullable-type') enrollment['type'] = ['boolean', 'null']
    else {
      const description = String(enrollment['description'])
      enrollment['description'] = {
        'local-totp': description.replace('signed local-TOTP registration fact', 'MFA fact'),
        'strict-false': description.replace('strict `false` means', '`false` may mean'),
        omission: description.replace('omission means unknown', 'omission means false'),
      }[mutation]
    }
    const reason = {
      'required-mfa': 'MFA enrollment optional',
      'default-false': 'MFA enrollment has no default',
      'nullable-type': 'MFA enrollment strict boolean',
      'local-totp': 'local TOTP enrollment',
      'strict-false': 'strict false enrollment semantics',
      omission: 'omission enrollment semantics',
    }[mutation]
    expect(() => checkMfaEnrollmentSemantics(changed)).toThrow(reason)
  })

  it.each(['missing503', 'retry2', 'cache', 'body', 'same-key'] as const)(
    'refuses the isolated %s semantic mutation with the pin check deliberately separate',
    (mutation) => {
      checkTransient(spec)
      checkGuidance(spec)
      const changed = structuredClone(spec)
      const responses = consumeResponses(changed)
      if (mutation === 'missing503') delete responses['503']
      else if (mutation === 'same-key') {
        const registry = object(changed.components.schemas['ProblemType'])
        registry['description'] = String(registry['description']).replace(
          'retry with a new logical key',
          'retry with the same logical key'
        )
      } else {
        const response = object(responses['503'])
        if (mutation === 'body') {
          const content = object(object(response['content'])['application/problem+json'])
          object(content['schema'])['$ref'] = '#/components/schemas/User'
        } else {
          const headers = object(response['headers'])
          const name = mutation === 'retry2' ? 'Retry-After' : 'Cache-Control'
          object(object(headers[name])['schema'])['const'] = mutation === 'retry2' ? 2 : 'public'
        }
      }
      const reason = {
        missing503: 'consume503 response required',
        retry2: 'retry literal one',
        cache: 'transient no-store',
        body: 'registered Problem',
        'same-key': 'contact new logical key',
      }[mutation]
      expect(() =>
        mutation === 'same-key' ? checkGuidance(changed) : checkTransient(changed)
      ).toThrow(reason)
    }
  )

  it('retains every operation, collection, schema, problem and protected mock byte', () => {
    const ops = operations(spec)
    expect(ops).toHaveLength(166)
    expect(new Set(ops.map((op) => op.operationId)).size).toBe(166)
    expect(ops.filter((op) => op.isList)).toHaveLength(35)
    expect(Object.keys(spec.components.schemas)).toHaveLength(246)
    expect(problems(spec)).toHaveLength(44)
    expect(PROBLEM_TYPES).toHaveLength(44)
    const hashes = {
      'src/mocks/generated/problems.ts':
        '82377473578e293b1f7fcea3a987e250f4f58ef0a0e9d89bb959052a6266cc88',
      'src/mocks/generated/examples.ts':
        '52e93bbabdceece9db7468ffb537471d622d193ee00c42b16f47336cedf2f13a',
      'src/mocks/generated/handlers.ts':
        'c30b4dc6f6b3e95d38054c6e93a07f1c1c263ae1a28f973730c870f65d8e5d35',
      'src/api/schema.d.ts': '0e394faee8bfb3fe01acd37f3418c1caec0f92f5b0e9cc882e81d23ab44e226d',
    }
    for (const [path, expected] of Object.entries(hashes)) {
      expect(sha(readFileSync(join(root, path)))).toBe(expected)
    }
  })

  it('keeps caller assurance out of the base bootstrap answer, as the current server omits it', () => {
    const assurance = object(spec.components.schemas['BootstrapCallerAssurance'])
    expect(assurance['required']).toEqual(['version', 'identity_id', 'authentication_mfa'])
    const bootstrap = object(spec.components.schemas['OrganisationBootstrap'])
    expect(bootstrap['required']).not.toContain('caller_assurance')
    expect(EXAMPLES['getOrganisationBootstrap'].body).not.toHaveProperty('caller_assurance')
  })
})

// All diagnostic checks execute in the test runner; no generated output is emitted.
const virtualRoot = join(root, '__contract_consumer_virtual__')
const schemaName = join(virtualRoot, 'schema.d.ts')
const probeName = join(virtualRoot, 'probe.ts')
const probe = [
  "import type { operations, components } from './schema';",
  'type Responses = operations["consumeOwnerClaim"]["responses"];',
  'type Response503 = Responses[503];',
  'type Present = 503 extends keyof Responses ? true : false;',
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;',
  'type Assert<T extends true> = T;',
  'type ExactRetry = Assert<Present extends true ? Equal<NonNullable<Response503["headers"]["Retry-After"]>, 1> : true>;',
  'type ExactCache = Assert<Present extends true ? Equal<NonNullable<Response503["headers"]["Cache-Control"]>, "no-store"> : true>;',
  'type ExactBody = Assert<Present extends true ? Equal<Response503["content"]["application/problem+json"], components["schemas"]["Problem"]> : true>;',
].join('\n')

function diagnostics(source: string, input = probe) {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    types: [],
  }
  const host = ts.createCompilerHost(options, true)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, error, createNew) =>
    file === schemaName
      ? ts.createSourceFile(file, source, language, true)
      : file === probeName
        ? ts.createSourceFile(file, input, language, true)
        : original(file, language, error, createNew)
  host.resolveModuleNames = (names) =>
    names.map((name) =>
      name === './schema'
        ? { resolvedFileName: schemaName, extension: ts.Extension.Dts }
        : undefined
    )
  host.writeFile = () => {
    throw new Error('compiler must not emit')
  }
  const program = ts.createProgram([schemaName, probeName], options, host)
  const libraries = program
    .getSourceFiles()
    .filter((file) => ![schemaName, probeName].includes(file.fileName))
  requireThat(
    libraries.length > 0 &&
      libraries.every(
        (file) =>
          file.isDeclarationFile &&
          file.fileName.startsWith(dirname(ts.getDefaultLibFilePath(options)) + '/')
      ),
    'standard compiler libraries only'
  )
  return ts.getPreEmitDiagnostics(program).map((item) => ({
    code: item.code,
    category: ts.DiagnosticCategory[item.category],
    file: item.file?.fileName === probeName ? 'probe' : 'unexpected-input',
    line:
      item.file && item.start !== undefined
        ? item.file.getLineAndCharacterOfPosition(item.start).line + 1
        : null,
  }))
}

function schemaMutation(kind: 'remove503' | 'widenRetry') {
  const tree = ts.createSourceFile('schema.d.ts', schema, ts.ScriptTarget.ES2022, true)
  const operationsNode = tree.statements.filter(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'operations'
  )
  requireThat(operationsNode.length === 1, 'one operations interface')
  function property(node: ts.TypeLiteralNode | ts.InterfaceDeclaration, name: string) {
    const matches = node.members.filter(
      (member): member is ts.PropertySignature =>
        ts.isPropertySignature(member) &&
        member.name.getText(tree).replaceAll('"', '').replaceAll("'", '') === name
    )
    requireThat(matches.length === 1, 'one exact generated property')
    return matches[0]!
  }
  function literal(node: ts.PropertySignature) {
    requireThat(node.type && ts.isTypeLiteralNode(node.type), 'generated type literal')
    return node.type
  }
  const operation = property(operationsNode[0]!, 'consumeOwnerClaim')
  const response = property(literal(property(literal(operation), 'responses')), '503')
  const retry = property(literal(property(literal(response), 'headers')), 'Retry-After')
  requireThat(retry.type?.getText(tree) === '1', 'generated retry literal one')
  const first = kind === 'remove503' ? response.getFullStart() : retry.type.getStart(tree)
  const last = kind === 'remove503' ? response.end : retry.type.end
  const replacement = kind === 'remove503' ? '' : 'number'
  const changed = schema.slice(0, first) + replacement + schema.slice(last)
  requireThat(
    changed !== schema &&
      changed.slice(0, first) === schema.slice(0, first) &&
      changed.slice(first + replacement.length) === schema.slice(last),
    'only exact AST range changes'
  )
  return changed
}

describe('actual generated declaration compiler diagnostics', () => {
  it('enables actual compiler diagnostics with a positive and a literal mismatch', () => {
    expect(diagnostics(schema, 'const control: 1 = 1;')).toEqual([])
    expect(diagnostics(schema, 'const control: 1 = 2;')).toEqual([
      { code: 2322, category: 'Error', file: 'probe', line: 1 },
    ])
  })

  it('compiles the actual 503, exact Retry-After, no-store and registered Problem surface', () => {
    expect(diagnostics(schema)).toEqual([])
  })

  it.each(['remove503', 'widenRetry'] as const)('detects the actual %s AST mutation', (kind) => {
    expect(diagnostics(schema)).toEqual([])
    expect(diagnostics(schemaMutation(kind))).toEqual([
      {
        code: kind === 'remove503' ? 2339 : 2344,
        category: 'Error',
        file: 'probe',
        line: kind === 'remove503' ? 3 : 7,
      },
    ])
  })
})

interface CapturedIntent {
  key: string | null
  body: string
}

function sameIntent(first: CapturedIntent, second: CapturedIntent) {
  requireThat(first.key !== null && first.key === second.key, 'same logical key')
  requireThat(first.body === second.body, 'same request body')
}

describe('the unchanged client under a bounded consume503', () => {
  const base = 'https://core.test/api/v1'
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  beforeEach(() => {
    vi.stubEnv('VITE_CORE_API_URL', base)
    setTokenProvider(() => undefined)
  })
  afterEach(() => {
    server.resetHandlers()
    resetIdempotencyStore()
    setTokenProvider(() => undefined)
    vi.unstubAllEnvs()
  })
  afterAll(() => server.close())

  it('raises a typed 503 once per call and preserves a deliberate same-key/body retry', async () => {
    const seen: CapturedIntent[] = []
    const requestId = '00000000-0000-4000-8000-000000000051'
    server.use(
      http.post(`${base}/owner-claims/actions/consume`, async ({ request }) => {
        seen.push({
          key: request.headers.get('Idempotency-Key'),
          body: await request.clone().text(),
        })
        return new Response(
          JSON.stringify({
            type: serviceType,
            title: 'Try again',
            status: 503,
            retry_after_s: 1,
            request_id: requestId,
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/problem+json',
              'Retry-After': '1',
              'Cache-Control': 'no-store',
              'X-Request-Id': requestId,
            },
          }
        )
      })
    )
    const key = '00000000-0000-4000-8000-000000000052'
    const body = { token: `oc1_01900000-0000-7000-8000-000000000001_${'A'.repeat(43)}` }
    const call = () =>
      coreApi().POST('/owner-claims/actions/consume', {
        params: { header: { 'Idempotency-Key': key } },
        body,
      })
    for (const count of [1, 2]) {
      const raised: unknown = await call().catch((error: unknown) => error)
      expect(raised).toBeInstanceOf(ApiProblem)
      requireThat(raised instanceof ApiProblem, 'actual ApiProblem')
      expect(raised.status).toBe(503)
      expect(raised.type).toBe(serviceType)
      expect(raised.retryAfterS).toBe(1)
      expect(raised.requestId).toBe(requestId)
      expect(seen).toHaveLength(count)
    }
    requireThat(seen[0] && seen[1], 'two completed client requests')
    expect(seen[0].key).toBe(key)
    expect(seen[0].body).toBe(JSON.stringify(body))
    sameIntent(seen[0], seen[1])
    expect(() => sameIntent(seen[0]!, { ...seen[1]!, key: `${key}-changed` })).toThrow(
      'same logical key'
    )
    expect(() =>
      sameIntent(seen[0]!, { ...seen[1]!, body: JSON.stringify({ token: `${body.token}A` }) })
    ).toThrow('same request body')
  })
})

describe("the contract's Espace mapping (0.25.2)", () => {
  // Normative for every client: a drift between the contract's alias rule and the one the
  // console builds would send every channel to a room that does not exist.
  it('names the channel room alias the console builds', () => {
    const rule = '#kodera-ch-{id}:{server_name}'
    expect(spec.info.description).toContain(rule)
    const id = '0b4e7c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
    const server = 'acme-sa.kodera.io'
    expect(channelRoomAlias(id, server)).toBe(
      rule.replace('{id}', id).replace('{server_name}', server)
    )
  })
})

describe('conditional write generation declarations', () => {
  it.each(['missing-alternative', 'missing-created-response'])(
    'refuses %s with its diagnostic',
    (mutation) => {
      const changed = structuredClone(spec)
      const path =
        '/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}'
      const put = object(object(changed.paths[path])['put'])
      if (mutation === 'missing-alternative') {
        put['parameters'] = (put['parameters'] as Record<string, unknown>[]).filter(
          (parameter) => parameter['name'] !== 'If-None-Match'
        )
      } else {
        delete object(put['responses'])['201']
      }
      expect(() => operations(changed)).toThrow(
        'conditional writes require both alternative headers and a 201 creation response'
      )
    }
  )
})
