import { describe, expect, it } from 'vitest'
import { componentNameKey, componentPillState, componentStateLabelKey } from './components'

describe('componentNameKey', () => {
  it('maps the three primary keys to their customer-facing label keys', () => {
    expect(componentNameKey('web')).toBe('console.status.overview.label-component-web')
    expect(componentNameKey('calls')).toBe('console.status.overview.label-component-calls')
    expect(componentNameKey('console')).toBe('console.status.overview.label-component-console')
  })
})

describe('componentStateLabelKey', () => {
  it('maps operational to its own label', () => {
    expect(componentStateLabelKey('operational')).toBe(
      'console.status.overview.status-component-operational'
    )
  })

  it('maps both outage severities to the one customer word "down"', () => {
    expect(componentStateLabelKey('partial_outage')).toBe(
      'console.status.overview.status-component-down'
    )
    expect(componentStateLabelKey('major_outage')).toBe(
      'console.status.overview.status-component-down'
    )
  })

  it('falls back to "unknown" for a state the console does not recognise, never operational', () => {
    expect(componentStateLabelKey('something-new')).toBe(
      'console.status.overview.status-component-unknown'
    )
  })
})

describe('componentPillState', () => {
  it('reads operational as success', () => {
    expect(componentPillState('operational')).toBe('success')
  })

  it('reads degraded as warning', () => {
    expect(componentPillState('degraded')).toBe('warning')
  })

  it('reads an unrecognised state as neutral, never success', () => {
    expect(componentPillState('something-new')).toBe('neutral')
  })
})
