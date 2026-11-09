import { describe, expect, it } from 'vitest'
import { hasLabel } from './stateLabel'

describe('hasLabel', () => {
  it('is on for words, off for nothing and for an empty string', () => {
    expect(hasLabel('non lu')).toBe(true)
    expect(hasLabel(undefined)).toBe(false)
    expect(hasLabel('')).toBe(false)
  })
})
