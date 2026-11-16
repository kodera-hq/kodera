// Preserve HeaderObject optionality across the pinned generator's reference branch.
import { ContractError, METHODS } from './spec.ts'
import type { JsonObject, Spec } from './spec.ts'

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(`Expected ${label} object`)
  }
  return value as JsonObject
}

/** Only response-header references are expanded; the pinned input is never mutated. */
export function optionalResponseHeadersForTypes(spec: Spec): Spec {
  const copy = structuredClone(spec)
  const headers = object(copy.components.headers ?? {}, 'components.headers')
  const prefix = '#/components/headers/'
  function resolve(ref: unknown, seen = new Set<string>()): JsonObject {
    if (typeof ref !== 'string' || !ref.startsWith(prefix) || seen.has(ref) || seen.size >= 64) {
      throw new ContractError('Unresolvable local response header reference')
    }
    const suffix = ref.slice(prefix.length)
    if (suffix.includes('/') || /~(?![01])/u.test(suffix)) {
      throw new ContractError('Invalid response header pointer')
    }
    const name = suffix.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!Object.hasOwn(headers, name)) throw new ContractError(`Missing response header ${ref}`)
    const target = object(headers[name], 'response header')
    if ('$ref' in target) return reference(target, new Set([...seen, ref]))
    if (target.required !== undefined && typeof target.required !== 'boolean') {
      throw new ContractError('Response header required must be boolean')
    }
    return structuredClone(target)
  }
  function reference(header: JsonObject, seen = new Set<string>()): JsonObject {
    if (Object.keys(header).some((key) => !['$ref', 'summary', 'description'].includes(key))) {
      throw new ContractError('Unsupported response header reference sibling')
    }
    const target = resolve(header.$ref, seen)
    for (const key of ['summary', 'description']) {
      if (Object.hasOwn(header, key)) {
        if (typeof header[key] !== 'string') {
          throw new ContractError(`Response header reference ${key} must be string`)
        }
        target[key] = header[key]
      }
    }
    return target
  }
  function response(value: unknown): void {
    const row = object(value, 'response')
    if ('$ref' in row || row.headers === undefined) return
    const entries = object(row.headers, 'response headers')
    for (const [name, value] of Object.entries(entries)) {
      const header = object(value, 'response header')
      if ('$ref' in header) {
        const resolved = reference(header)
        if (resolved.required !== true) entries[name] = resolved
      }
    }
  }
  // The admitted contract has response headers in operation responses and components.responses.
  // References to component responses remain intact; their declarations are normalized here.
  for (const path of Object.values(copy.paths)) {
    for (const method of METHODS) {
      if (path[method] === undefined) continue
      const operation = object(path[method], 'operation')
      for (const value of Object.values(object(operation.responses ?? {}, 'responses')))
        response(value)
    }
  }
  for (const value of Object.values(
    object(copy.components.responses ?? {}, 'components.responses')
  )) {
    response(value)
  }
  return copy
}
