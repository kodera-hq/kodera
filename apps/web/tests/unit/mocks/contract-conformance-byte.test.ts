import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '@/mocks/generated/examples'
import { Contract, isCanonicalBase64Byte } from './contract-conformance'

const VALID = ['', 'AA==', 'AQ==', '/w==', 'AAA=', 'AQI=', '//8=', 'AAAA', 'AQID', '++++']
const INVALID = [
  'AB==',
  'AR==',
  'Af==',
  'A/==',
  'AAB=',
  'AAZ=',
  'AA/=',
  'A',
  'AA',
  'AAA',
  'AAAA=',
  'A===',
  '=AAA',
  'AA===',
  'AAA==',
  'AA=A',
  'AA==AA==',
  '-_==',
  'AA-_',
  ' AA==',
  'AA== ',
  '\tAA==',
  'AA==\n',
  'AA==\r\n',
  'A\n==',
]

function byteContract(): Contract {
  return new Contract(
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Byte format control', version: '1.0.0' },
      paths: {
        '/bytes': {
          get: {
            operationId: 'getBytes',
            responses: {
              200: {
                content: { 'application/json': { schema: { type: 'string', format: 'byte' } } },
              },
            },
          },
        },
      },
    })
  )
}

async function violations(
  contract: Contract,
  method: string,
  path: string,
  body: unknown,
  status = 200
) {
  const route = contract.route(method, path)
  if (route === undefined) throw new Error('Expected control route is missing')
  return contract.violations(route, Response.json(body, { status }))
}

describe('canonical padded standard base64 byte format', () => {
  it.each(VALID)(
    'accepts the canonical encoding %j, including empty and 1/2/3-byte values',
    async (value) => {
      expect(isCanonicalBase64Byte(value)).toBe(true)
      expect(await violations(byteContract(), 'get', '/bytes', value)).toEqual([])
    }
  )

  it.each(INVALID)(
    'refuses noncanonical encoding %j through the registered format',
    async (value) => {
      expect(isCanonicalBase64Byte(value)).toBe(false)
      expect(await violations(byteContract(), 'get', '/bytes', value)).toEqual([
        'status 200 / must match format "byte"',
      ])
    }
  )

  it.each([[null], [true], [0], [[]], [{}]])('refuses non-string JSON values %j', async (value) => {
    expect(isCanonicalBase64Byte(value)).toBe(false)
    expect(await violations(byteContract(), 'get', '/bytes', value)).toEqual([
      'status 200 / must be string',
    ])
  })

  it('does not coerce undefined or boxed strings into bytes', () => {
    expect(isCanonicalBase64Byte(undefined)).toBe(false)
    expect(isCanonicalBase64Byte(Object('AA=='))).toBe(false)
  })

  it('validates the actual confidential registration schema and refuses nonzero pad bits', async () => {
    const contract = new Contract()
    const example = EXAMPLES.registerConfidentialDevice
    const body = structuredClone(example.body) as { signingKey: string }
    expect(await violations(contract, example.method, example.path, body, example.status)).toEqual(
      []
    )
    // Same length and alphabet: the schema's pattern alone admits this noncanonical value.
    body.signingKey = `${body.signingKey.slice(0, -2)}B=`
    expect(await violations(contract, example.method, example.path, body, example.status)).toEqual([
      'status 201 /signingKey must match format "byte"',
    ])
  })

  it('validates actual confidential envelope bytes and refuses nonzero pad bits', async () => {
    const contract = new Contract()
    const example = EXAMPLES.listConfidentialEnvelopes
    const body = structuredClone(example.body) as { envelopes: { ciphertext: string }[] }
    expect(await violations(contract, example.method, example.path, body, example.status)).toEqual(
      []
    )
    const first = body.envelopes[0]
    if (first === undefined) throw new Error('Pinned confidential example has no envelope')
    first.ciphertext = `${first.ciphertext.slice(0, -2)}B=`
    expect(await violations(contract, example.method, example.path, body, example.status)).toEqual([
      'status 200 /envelopes/0/ciphertext must match format "byte"',
    ])
  })
})
