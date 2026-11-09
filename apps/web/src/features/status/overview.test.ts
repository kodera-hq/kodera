import { describe, expect, it } from 'vitest'
import { overallState, worstComponent } from './overview'
import type { StatusComponent } from './components'

function component(overrides: Partial<StatusComponent>): StatusComponent {
  return {
    id: 'c-1',
    scope: 'platform',
    key: 'web',
    name: 'Web',
    state: 'operational',
    since: '2026-12-03T10:00:00Z',
    ...overrides,
  }
}

describe('overallState', () => {
  it('is healthy when every component is operational', () => {
    expect(overallState([component({}), component({ key: 'calls' })], false)).toBe('healthy')
  })

  it('is degraded when a component is not operational', () => {
    expect(overallState([component({ key: 'calls', state: 'degraded' })], false)).toBe('degraded')
  })

  it('is stale when the agent heartbeat is stale, even with healthy components', () => {
    expect(overallState([component({})], true)).toBe('stale')
  })

  it('prefers stale over degraded — a stale reading is never presented as an outage', () => {
    expect(overallState([component({ key: 'calls', state: 'degraded' })], true)).toBe('stale')
  })
})

describe('worstComponent', () => {
  it('returns undefined when everything is operational', () => {
    expect(worstComponent([component({}), component({ key: 'calls' })])).toBeUndefined()
  })

  it('returns the one degraded component', () => {
    const calls = component({ key: 'calls', state: 'degraded' })
    expect(worstComponent([component({}), calls])).toBe(calls)
  })

  it('picks the most severe among several non-operational components', () => {
    const degraded = component({ key: 'calls', state: 'degraded' })
    const down = component({ key: 'web', state: 'major_outage' })
    expect(worstComponent([degraded, down])).toBe(down)
  })
})

it('keeps an unrecognized component observation unknown instead of claiming degradation', () => {
  expect(overallState([{ key: 'web', state: 'future-observation' }] as never, false)).toBe(
    'unknown'
  )
})

it('still identifies a known outage when another observation has an unknown state', () => {
  const unknown = { key: 'web', state: 'future-observation' } as never
  const outage = component({ key: 'calls', state: 'major_outage' })
  expect(overallState([unknown, outage], false)).toBe('degraded')
  expect(worstComponent([unknown, outage])).toBe(outage)
})
