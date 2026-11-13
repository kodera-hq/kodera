import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkLicenses } from '../licenses.mjs'

test('reviewed runtime lock is pinned and excludes reciprocal licenses', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)))
  assert.ok(checkLicenses(lock).length > 0)
  const name = Object.keys(lock.packages).find(name => name)
  const license = lock.packages[name].license
  lock.packages[name].license = 'GPL-3.0-only'
  assert.throws(() => checkLicenses(lock), /Unreviewed runtime license/)
  lock.packages[name].license = license
  lock.packages[name].integrity = 'unpinned'
  assert.throws(() => checkLicenses(lock), /Unpinned runtime package/)
})
