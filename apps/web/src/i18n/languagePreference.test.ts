import { afterEach, expect, it, vi } from 'vitest'
import { keepLanguagePreference, readLanguagePreference } from './languagePreference'
afterEach(() => {
  sessionStorage.removeItem('console:language')
  vi.restoreAllMocks()
})
it('keeps the explicit language through the sign-in reload and rejects unknown values', () => {
  expect(readLanguagePreference()).toBe('fr')
  keepLanguagePreference('en')
  expect(readLanguagePreference()).toBe('en')
  sessionStorage.setItem('console:language', 'unknown')
  expect(readLanguagePreference()).toBe('fr')
})
it('falls back safely when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied')
  })
  expect(() => keepLanguagePreference('en')).not.toThrow()
  expect(readLanguagePreference()).toBe('fr')
})
