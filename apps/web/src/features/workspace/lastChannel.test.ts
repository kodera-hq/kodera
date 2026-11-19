import { expect, it, vi } from 'vitest'
import { readLastChannel, saveLastChannel } from './lastChannel'
it('isolates remembered channels by organisation and identity', () => {
  localStorage.clear()
  saveLastChannel('one', 'person', 'general')
  expect(readLastChannel('one', 'person')).toBe('general')
  expect(readLastChannel('two', 'person')).toBeUndefined()
  expect(readLastChannel('one', 'other')).toBeUndefined()
})
it('leaves navigation usable when storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(() => saveLastChannel('one', 'person', 'general')).not.toThrow()
  expect(readLastChannel('one', 'person')).toBeUndefined()
})
