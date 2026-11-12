// Judges a mock response against the pinned Core API contract.
//
// With a real JSON Schema validator rather than a reader written here: the contract is
// OpenAPI 3.1, its schemas are JSON Schema 2020-12, and `@redocly/ajv` is the 2020-12
// validator the generator's own toolchain (openapi-typescript) already resolves. A
// hand-rolled check would agree with whichever keywords its author remembered.
//
// It names three failures, each silent in a suite that only asserts what a screen renders:
// a handler answering a route the contract does not have; a status the operation does not
// declare; a body the declared schema refuses — an enum member the contract dropped, a
// pattern it narrowed, a field it made required.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from '@redocly/ajv/dist/2020'
import type { ValidateFunction } from '@redocly/ajv/dist/2020'
import type { HttpHandler } from 'msw'
import { parse } from 'yaml'

type JsonObject = Record<string, unknown>

export const CONTRACT_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'core-api.openapi.yaml'
)

const API_PREFIX = '/api/v1'
const ORIGIN = 'https://core.test'
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
export type Method = (typeof METHODS)[number]

/** Stands in for a path parameter a handler matches on shape rather than on value. */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000001'

export interface Route {
  readonly method: Method
  /** The contract's templated path, `/invoices/{invoice_id}`. */
  readonly path: string
  readonly operationId: string
}

/** What a handler says it answers, with MSW's `:param` rewritten as the contract's `{param}`. */
export interface HandlerRoute {
  readonly method: string
  readonly path: string
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

/** One JSON Pointer segment, escaped for a pointer and then for a URI fragment. */
function pointerSegment(segment: string): string {
  return encodeURIComponent(segment.replace(/~/g, '~0').replace(/\//g, '~1'))
}

/**
 * Every `format` this check validates. `int64` and `binary` describe an encoding, not a shape
 * a JSON value can fail, so they accept what they are given. With `strict: false` Ajv only
 * warns about a format it does not know and then accepts any value for it, so a contract
 * that uses a format missing here is refused when the check is built.
 */
const FORMATS: Readonly<Record<string, RegExp | true>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[a-z][a-z0-9+.-]*:\S*$/i,
  'uri-reference': /^\S*$/,
  int64: true,
  binary: true,
}

/** Every `format` keyword value in the document, examples and prose aside. */
function formatsUsed(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) formatsUsed(item, found)
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'examples' || key === 'example' || key === 'description') continue
      if (key === 'format' && typeof value === 'string') found.add(value)
      else formatsUsed(value, found)
    }
  }
  return found
}

export class Contract {
  private readonly document: JsonObject
  private readonly ajv: Ajv2020
  private readonly routes: Route[] = []
  private readonly validators = new Map<string, ValidateFunction>()

  constructor(source: string = readFileSync(CONTRACT_PATH, 'utf8')) {
    this.document = parse(source) as JsonObject
    // `strict: false` because an OpenAPI document carries keywords JSON Schema does not
    // define (`x-kodera-*`, `discriminator`-free but `examples`-rich); they describe, they
    // do not constrain. `validateSchema: false` because the document root is not a schema.
    this.ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false })
    const unregistered = [...formatsUsed(this.document)].filter(
      (format) => !Object.hasOwn(FORMATS, format)
    )
    if (unregistered.length > 0) {
      throw new Error(
        `The contract uses format ${unregistered.sort().join(', ')}, which this check does not ` +
          'validate. Register it in FORMATS: an unregistered format accepts any value.'
      )
    }
    for (const [name, format] of Object.entries(FORMATS)) this.ajv.addFormat(name, format)
    this.ajv.addSchema(this.document, 'contract')

    for (const [path, item] of Object.entries(asObject(this.document['paths']) ?? {})) {
      for (const method of METHODS) {
        const operationId = asObject(asObject(item)?.[method])?.['operationId']
        if (typeof operationId === 'string') this.routes.push({ method, path, operationId })
      }
    }
  }

  /** How many operations the contract declares — a floor for a caller that iterates them. */
  get operationCount(): number {
    return this.routes.length
  }

  /**
   * The contract operation a request for `method` and templated `path` reaches, or
   * `undefined` when the contract has no such route.
   */
  route(method: string, path: string): Route | undefined {
    const segments = path.split('/')
    let best: { route: Route; literals: number } | undefined
    for (const route of this.routes) {
      if (route.method !== method) continue
      const expected = route.path.split('/')
      if (expected.length !== segments.length) continue
      let literals = 0
      const fits = expected.every((segment, i) => {
        if (segment.startsWith('{')) return true
        if (segment !== segments[i]) return false
        literals += 1
        return true
      })
      // `/memberships/count` fits `/memberships/{membership_id}` too; the reading with more
      // literal segments is the route a request to it actually reaches.
      if (fits && (best === undefined || literals > best.literals)) best = { route, literals }
    }
    return best?.route
  }

  /**
   * A URL that reaches `route` through a handler declared at `handlerPath`: literal
   * segments the handler matched on are kept, parameters get a placeholder id, and every
   * required query parameter the contract gives an example for is filled in.
   */
  url(route: Route, handlerPath: string): string {
    const query = new URLSearchParams()
    for (const parameter of this.parameters(route)) {
      if (parameter['in'] !== 'query' || parameter['required'] !== true) continue
      const schema = asObject(parameter['schema'])
      const examples = schema?.['examples']
      const value =
        parameter['example'] ??
        (Array.isArray(examples) ? examples[0] : undefined) ??
        schema?.['default']
      if (value !== undefined) query.set(String(parameter['name']), String(value))
    }
    const concrete = handlerPath.replace(/\{[^{}]+\}/g, PLACEHOLDER_ID)
    const search = query.toString()
    return `${ORIGIN}${API_PREFIX}${concrete}${search === '' ? '' : `?${search}`}`
  }

  /** Every way `response` falls outside what `route` declares; empty when it conforms. */
  async violations(route: Route, response: Response): Promise<string[]> {
    const responses = asObject(this.operation(route)['responses']) ?? {}
    const status = String(response.status)
    const wildcard = `${status.charAt(0)}XX`
    const key =
      status in responses
        ? status
        : wildcard in responses
          ? wildcard
          : 'default' in responses
            ? 'default'
            : undefined
    if (key === undefined) {
      return [`status ${status} is not declared (declared: ${Object.keys(responses).join(', ')})`]
    }

    const raw = asObject(responses[key]) ?? {}
    const ref = raw['$ref']
    const base =
      typeof ref === 'string'
        ? ref.slice(1)
        : `/paths/${pointerSegment(route.path)}/${route.method}/responses/${key}`
    const declared = typeof ref === 'string' ? this.resolve(ref) : raw
    const content = asObject(declared['content'])
    const text = await response.clone().text()

    if (content === undefined) {
      return text === ''
        ? []
        : [`status ${status} carries a body the contract declares without one`]
    }
    if (text === '') {
      return [
        `status ${status} carries no body; the contract declares ${Object.keys(content).join(', ')}`,
      ]
    }
    const mediaType = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? ''
    if (!(mediaType in content)) {
      return [
        `status ${status} is ${mediaType === '' ? 'untyped' : mediaType}; ` +
          `the contract declares ${Object.keys(content).join(', ')}`,
      ]
    }
    let body: unknown
    if (mediaType === 'text/plain') {
      body = text
    } else {
      try {
        body = JSON.parse(text)
      } catch {
        return [`status ${status} carries a body that is not JSON`]
      }
    }

    const validate = this.validator(`${base}/content/${pointerSegment(mediaType)}/schema`)
    if (validate(body)) return []
    return (validate.errors ?? []).map((error) => {
      const allowed =
        error.keyword === 'enum' ? ` ${JSON.stringify(error.params['allowedValues'])}` : ''
      return `status ${status} ${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? error.keyword}${allowed}`
    })
  }

  private operation(route: Route): JsonObject {
    const operation = asObject(
      asObject(asObject(this.document['paths'])?.[route.path])?.[route.method]
    )
    if (operation === undefined) throw new Error(`${route.operationId} is not in the contract`)
    return operation
  }

  private parameters(route: Route): JsonObject[] {
    const item = asObject(asObject(this.document['paths'])?.[route.path]) ?? {}
    const shared = Array.isArray(item['parameters']) ? item['parameters'] : []
    const own = this.operation(route)['parameters']
    return [...shared, ...(Array.isArray(own) ? own : [])].flatMap((parameter) => {
      const object = asObject(parameter)
      if (object === undefined) return []
      const ref = object['$ref']
      return [typeof ref === 'string' ? this.resolve(ref) : object]
    })
  }

  private resolve(ref: string): JsonObject {
    let node: unknown = this.document
    for (const raw of ref.replace(/^#\//, '').split('/')) {
      node = asObject(node)?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')]
    }
    const resolved = asObject(node)
    if (resolved === undefined) throw new Error(`Unresolvable ref ${ref}`)
    return resolved
  }

  private validator(pointer: string): ValidateFunction {
    const cached = this.validators.get(pointer)
    if (cached !== undefined) return cached
    const validate = this.ajv.compile({ $ref: `contract#${pointer}` })
    this.validators.set(pointer, validate)
    return validate
  }
}

/** The route a handler declares, or `undefined` when it is not a string route under `/api/v1`. */
export function handlerRoute(handler: HttpHandler): HandlerRoute | undefined {
  const { method, path } = handler.info
  if (typeof method !== 'string' || typeof path !== 'string') return undefined
  const at = path.indexOf(`${API_PREFIX}/`)
  if (at === -1) return undefined
  return {
    method: method.toLowerCase(),
    path: path.slice(at + API_PREFIX.length).replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
  }
}

/**
 * Runs `handler` on a request for `url`, with no server in between, and returns what it
 * answered — `undefined` when the handler let the request fall through.
 *
 * A write carries the headers the contract requires of it (`Idempotency-Key` on a `POST`,
 * `If-Match` on a `PATCH`), so a handler that refuses a request missing them is judged on
 * its real answer rather than on the refusal.
 */
export async function runHandler(
  handler: HttpHandler,
  method: Method,
  url: string
): Promise<Response | undefined> {
  const headers = new Headers()
  let body: string | undefined
  if (method === 'post' || method === 'put' || method === 'patch') {
    headers.set(
      'Content-Type',
      method === 'patch' ? 'application/merge-patch+json' : 'application/json'
    )
    body = '{}'
  }
  if (method === 'post') headers.set('Idempotency-Key', 'overlay-contract-conformance')
  if (method === 'patch') headers.set('If-Match', '"overlay-contract-conformance"')
  const request = new Request(url, {
    method: method.toUpperCase(),
    headers,
    ...(body === undefined ? {} : { body }),
  })
  const result = await handler.run({
    request: request as Parameters<HttpHandler['run']>[0]['request'],
    requestId: crypto.randomUUID(),
  })
  return result?.response
}
