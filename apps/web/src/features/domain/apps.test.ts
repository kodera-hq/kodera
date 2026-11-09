import { describe, expect, it } from 'vitest'
import fr from '../../i18n/fr.json'
import { appLabelKey, isAppCode } from './apps'

const named = (app: string | null | undefined) => {
  const key = appLabelKey(app)
  return key === null ? null : fr[key]
}

describe('the application an address serves', () => {
  it('is named as the Applications screen names it', () => {
    expect(named('visio')).toBe('Visio')
    expect(named('docs')).toBe('Docs')
  })

  it('has no name, rather than a raw code, when the catalogue has none', () => {
    expect(named('drive')).toBeNull()
    expect(named('messaging')).toBeNull()
    expect(named('grist')).toBeNull()
    expect(named('login')).toBeNull()
    expect(named(null)).toBeNull()
    expect(named(undefined)).toBeNull()
    // An inherited property is not an application.
    expect(named('constructor')).toBeNull()
  })

  it('knows a contract application code from anything else', () => {
    expect(isAppCode('grist')).toBe(true)
    expect(isAppCode('mail')).toBe(false)
    expect(isAppCode(7)).toBe(false)
  })
})
