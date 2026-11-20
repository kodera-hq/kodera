import { expect, it } from 'vitest'
import { formatBytes } from './formatBytes'
it('uses localized units and nonbreaking separators at every magnitude', () => {
  expect([0, 1024, 1024 ** 2, 1024 ** 3].map((v) => formatBytes(v, 'fr'))).toEqual([
    '0\u00a0o',
    '1\u00a0Ko',
    '1\u00a0Mo',
    '1\u00a0Go',
  ])
  expect(formatBytes(1536, 'en')).toBe('1.5\u00a0KB')
  expect(formatBytes(-1, 'fr')).toBe('0\u00a0o')
})
