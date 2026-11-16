import assert from 'node:assert/strict'
import test from 'node:test'
import openapiTS from 'openapi-typescript'
import ts from 'typescript'
import { optionalResponseHeadersForTypes } from './response-headers.ts'
import type { JsonObject, Spec } from './spec.ts'

function object(value: unknown): JsonObject {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as JsonObject
}

function responseHeaders(spec: Spec): JsonObject {
  const responses = object(object(object(spec.paths['/example']).get).responses)
  return object(object(responses['200']).headers)
}

function componentHeaders(spec: Spec): JsonObject {
  return object(spec.components.headers)
}

function fixture(): Spec {
  return {
    openapi: '3.1.0',
    info: { title: 'Header fixture', version: '1.0.0' },
    paths: {
      '/example': {
        get: {
          operationId: 'example',
          responses: {
            200: {
              description: 'Example',
              headers: {
                'X-Optional': { $ref: '#/components/headers/Optional' },
                'X-Unspecified': { $ref: '#/components/headers/Unspecified' },
                'X-Required': { $ref: '#/components/headers/Required' },
                'X-Alias': { $ref: '#/components/headers/Alias' },
                'X-Inline': { required: false, schema: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Example: {
          type: 'object',
          properties: {
            untouched: { type: 'string', description: 'Keep schema fields' },
          },
        },
      },
      headers: {
        Optional: { required: false, schema: { type: 'string', const: 'true' } },
        Unspecified: { schema: { type: 'integer' } },
        Required: { required: true, schema: { type: 'string' } },
        Alias: { $ref: '#/components/headers/Optional', description: 'Alias description' },
      },
      responses: {
        Shared: {
          description: 'Shared',
          headers: {
            'X-Shared': { $ref: '#/components/headers/Optional' },
          },
        },
      },
    },
  }
}

test('only optional response references expand; input and unrelated schema remain exact', () => {
  const input = fixture(),
    original = structuredClone(input)
  const result = optionalResponseHeadersForTypes(input)
  assert.deepEqual(input, original)
  const headers = responseHeaders(result)
  assert.deepEqual(headers['X-Required'], { $ref: '#/components/headers/Required' })
  assert.equal(object(headers['X-Optional']).required, false)
  assert.equal(object(headers['X-Unspecified']).required, undefined)
  assert.equal(object(headers['X-Alias']).description, 'Alias description')
  assert.deepEqual(result.components.schemas, input.components.schemas)
  assert.deepEqual(result.components.headers, input.components.headers)
  const shared = object(object(object(result.components.responses).Shared).headers)
  assert.equal(object(shared['X-Shared']).required, false)
})

test('actual pinned emitter produces optional and required property signatures correctly', async () => {
  const nodes = await openapiTS(
    optionalResponseHeadersForTypes(fixture()) as Parameters<typeof openapiTS>[0]
  )
  const seen: Record<string, boolean> = {}
  function visit(node: ts.Node): void {
    if (
      ts.isPropertySignature(node) &&
      node.name &&
      ts.isStringLiteral(node.name) &&
      node.name.text.startsWith('X-')
    )
      seen[node.name.text] = !!node.questionToken
    ts.forEachChild(node, visit)
  }
  nodes.forEach(visit)
  assert.deepEqual(seen, {
    'X-Optional': true,
    'X-Unspecified': true,
    'X-Required': false,
    'X-Alias': true,
    'X-Inline': true,
    'X-Shared': true,
  })
  // Calibration: bypassing the adapter must reproduce the pinned emitter's reference defect.
  const baseline = await openapiTS(fixture() as Parameters<typeof openapiTS>[0])
  const signatures: boolean[] = []
  function raw(node: ts.Node): void {
    if (
      ts.isPropertySignature(node) &&
      node.name &&
      ts.isStringLiteral(node.name) &&
      node.name.text === 'X-Optional'
    )
      signatures.push(!!node.questionToken)
    ts.forEachChild(node, raw)
  }
  baseline.forEach(raw)
  assert.deepEqual(signatures, [false])
})

test('broken, external, cyclic and malformed header refs refuse before generation', () => {
  for (const bad of [
    '#/components/headers/Missing',
    'https://example.invalid/header',
    '#/components/headers/Bad~2Name',
  ]) {
    const input = fixture()
    responseHeaders(input)['X-Optional'] = { $ref: bad }
    assert.throws(() => optionalResponseHeadersForTypes(input))
  }
  const cycle = fixture()
  componentHeaders(cycle).Optional = { $ref: '#/components/headers/Alias' }
  assert.throws(() => optionalResponseHeadersForTypes(cycle), /Unresolvable/)
  const wrong = fixture()
  object(componentHeaders(wrong).Optional).required = 'false'
  assert.throws(() => optionalResponseHeadersForTypes(wrong), /required must be boolean/)
  const sibling = fixture()
  object(responseHeaders(sibling)['X-Optional']).required = false
  assert.throws(() => optionalResponseHeadersForTypes(sibling), /Unsupported/)
  for (const key of ['summary', 'description']) {
    const malformed = fixture()
    object(responseHeaders(malformed)['X-Optional'])[key] = 42
    assert.throws(() => optionalResponseHeadersForTypes(malformed), /must be string/)
  }
})
