// A schema with several examples answers with the one the console named, not the first.
//
// `RealmDiscoveryResult` carries three examples — zero, one and several organisations —
// and the base mock used to be whichever the contract listed first. A reorder upstream
// would have swapped the sign-in screen's default answer with every check still green:
// the regeneration check compares the output with itself. These tests hold the named
// choices (`EXAMPLE_CHOICES` in scripts/api/spec.ts) to the pinned contract, and prove
// that a reorder, a missing choice and an ambiguous one each behave as they should.

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ContractError,
  EXAMPLE_CHOICES,
  exampleOf,
  operations,
  readPinnedSpec,
} from '../../../scripts/api/spec.ts'
import type { ExampleChoice, JsonObject, Spec } from '../../../scripts/api/spec.ts'

const root = join(import.meta.dirname, '..', '..', '..')
const pinned: Spec = readPinnedSpec(
  join(root, 'contracts', 'core-api.openapi.yaml'),
  join(root, 'contracts', 'contract.lock.json')
)

function examplesOf(spec: Spec, name: string): unknown[] {
  const examples = spec.components.schemas[name]?.['examples']
  return Array.isArray(examples) ? examples : []
}

function bodyOf(spec: Spec, operationId: string): unknown {
  return operations(spec).find((op) => op.operationId === operationId)?.body
}

/** The pinned contract with one schema's examples rearranged. */
function withExamples(name: string, rearrange: (examples: unknown[]) => unknown[]): Spec {
  const spec = structuredClone(pinned)
  const schema = spec.components.schemas[name] as JsonObject
  schema['examples'] = rearrange(examplesOf(pinned, name))
  return spec
}

describe('the named example choices', () => {
  it('cover every schema in the pinned contract that carries more than one example', () => {
    const several = Object.entries(pinned.components.schemas)
      .filter(([, schema]) => Array.isArray(schema['examples']) && schema['examples'].length > 1)
      .map(([name]) => name)
      .sort()
    // A count that dropped to zero would make the next test vacuous.
    expect(several).toContain('RealmDiscoveryResult')
    expect(Object.keys(EXAMPLE_CHOICES).sort()).toEqual(several)
  })

  it.each(Object.entries(EXAMPLE_CHOICES))(
    '%s names exactly one of its examples in the pinned contract',
    (name, choice) => {
      const examples = examplesOf(pinned, name)
      expect(examples.length).toBeGreaterThan(1)
      expect(examples.filter((example) => choice.matches(example))).toHaveLength(1)
    }
  )

  it('answers sign-in discovery with the neutral zero result', () => {
    expect(bodyOf(pinned, 'discoverRealm')).toEqual({
      realm: null,
      issuer: null,
      openid_configuration_url: null,
      organisation: null,
      candidates: [],
    })
  })

  it('answers the same whatever order the contract lists the examples in', () => {
    const base = bodyOf(pinned, 'discoverRealm')
    const reversed = withExamples('RealmDiscoveryResult', (examples) => [...examples].reverse())
    const rotated = withExamples('RealmDiscoveryResult', ([first, ...rest]) => [...rest, first])
    // The mutation is real: the first example is no longer the zero result.
    expect(examplesOf(reversed, 'RealmDiscoveryResult')[0]).not.toEqual(base)
    expect(examplesOf(rotated, 'RealmDiscoveryResult')[0]).not.toEqual(base)
    expect(bodyOf(reversed, 'discoverRealm')).toEqual(base)
    expect(bodyOf(rotated, 'discoverRealm')).toEqual(base)

    const workspace = bodyOf(pinned, 'getWorkspace')
    expect(workspace).toMatchObject({ state: 'initialised' })
    const workspaceReversed = withExamples('Workspace', (examples) => [...examples].reverse())
    expect(bodyOf(workspaceReversed, 'getWorkspace')).toEqual(workspace)
  })

  it('answers caller assurance with its minimal example, whatever the order', () => {
    const assurance: JsonObject = { $ref: '#/components/schemas/BootstrapCallerAssurance' }
    const minimal = {
      version: 1,
      identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
      authentication_mfa: false,
    }
    expect(exampleOf(pinned, assurance, 'op')).toEqual(minimal)
    const reversed = withExamples('BootstrapCallerAssurance', (examples) => [...examples].reverse())
    expect(examplesOf(reversed, 'BootstrapCallerAssurance')[0]).not.toEqual(minimal)
    expect(exampleOf(reversed, assurance, 'op')).toEqual(minimal)
  })
})

describe('the generator refuses to guess', () => {
  const several: JsonObject = { type: 'object', examples: [{ n: 1 }, { n: 2 }] }
  const spec = { components: { schemas: { Several: several } } } as unknown as Spec
  const ref: JsonObject = { $ref: '#/components/schemas/Several' }

  it('stops on a schema with several examples and no named choice', () => {
    expect(() => exampleOf(spec, ref, 'op', undefined, {})).toThrow(ContractError)
    expect(() => exampleOf(spec, ref, 'op', undefined, {})).toThrow(/no named choice for Several/)
  })

  it('stops on an inline schema with several examples', () => {
    expect(() => exampleOf(spec, several, 'op', undefined, {})).toThrow(
      /no named choice for this inline schema/
    )
  })

  const always =
    (answer: boolean): ExampleChoice['matches'] =>
    () =>
      answer
  it.each([
    ['none', always(false)],
    ['both', always(true)],
  ])('stops when the choice matches %s of the examples', (_, matches) => {
    const choices: Record<string, ExampleChoice> = { Several: { name: 'second', matches } }
    expect(() => exampleOf(spec, ref, 'op', undefined, choices)).toThrow(
      /"second" example of Several matches \d of its 2 examples/
    )
  })

  it('answers with the one the choice names, wherever it sits', () => {
    const choices: Record<string, ExampleChoice> = {
      Several: { name: 'second', matches: (e) => (e as { n: number }).n === 2 },
    }
    expect(exampleOf(spec, ref, 'op', undefined, choices)).toEqual({ n: 2 })
  })

  it('keeps taking the only example of a schema that carries one', () => {
    const single = { components: { schemas: { One: { examples: [{ n: 1 }] } } } } as unknown as Spec
    expect(exampleOf(single, { $ref: '#/components/schemas/One' }, 'op', undefined, {})).toEqual({
      n: 1,
    })
  })

  it('stops on a text/plain response with no string example', () => {
    const withoutPlainExample = structuredClone(pinned)
    const get = (
      withoutPlainExample.paths['/legal-documents/{code}/{version}/{locale}'] as JsonObject
    )['get'] as JsonObject
    const responses = get['responses'] as JsonObject
    const ok = responses['200'] as JsonObject
    const content = ok['content'] as JsonObject
    const plain = content['text/plain'] as JsonObject
    delete plain['example']
    expect(() => operations(withoutPlainExample)).toThrow(ContractError)
    expect(() => operations(withoutPlainExample)).toThrow(/getLegalDocumentText: no example/)

    delete plain['schema']
    expect(() => operations(withoutPlainExample)).toThrow(ContractError)
    expect(() => operations(withoutPlainExample)).toThrow(/getLegalDocumentText: no string example/)

    plain['example'] = 42
    expect(() => operations(withoutPlainExample)).toThrow(ContractError)
    expect(() => operations(withoutPlainExample)).toThrow(/getLegalDocumentText: no string example/)
  })
})
