// The i18n runtime as a browser runs it: the entry namespaces with the application, every other
// catalogue fetched when asked for. The rest of the suite never sees this — under Vitest the
// runtime loads the whole catalogue up front (`./index.ts`) — so each test here imports a fresh
// copy with the mode a build has, where nothing is preloaded and a missing key throws.
import type * as I18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import wholeEn from './en.json'
import wholeFr from './fr.json'
import type * as RuntimeModule from './index'
import { ENTRY_NAMESPACES, MESSAGE_NAMESPACES, namespaceOfKey } from './namespaces'

type Runtime = typeof RuntimeModule

async function asABuildRunsIt(language?: 'en'): Promise<Runtime> {
  vi.resetModules()
  // i18next's default export is one instance for the whole process, and a module reset does not
  // reach it. Each fresh runtime gets an instance of its own, so no test starts from another's
  // catalogues or language.
  vi.doMock('i18next', async () => {
    const actual = await vi.importActual<typeof I18next>('i18next')
    return { ...actual, default: actual.default.createInstance() }
  })
  // Not `test`, so the whole-catalogue preload is skipped; not a production build either, so a
  // missing key still throws instead of logging — the loudest way a test can learn of one.
  vi.stubEnv('MODE', 'development')
  if (language === undefined) sessionStorage.removeItem('console:language')
  else sessionStorage.setItem('console:language', language)
  return import('./index')
}

const PEOPLE_KEY = 'console.people.list.title'
const ENTRY_KEY = 'console.common.action-cancel'

beforeEach(() => sessionStorage.clear())
afterEach(() => {
  vi.doUnmock('i18next')
  vi.unstubAllEnvs()
  sessionStorage.clear()
})

describe('in the default language', () => {
  it('carries the entry namespaces and nothing else', async () => {
    const { default: i18n, hasNamespaces, entryCataloguesReady } = await asABuildRunsIt()
    await entryCataloguesReady
    expect(hasNamespaces(ENTRY_NAMESPACES)).toBe(true)
    for (const namespace of MESSAGE_NAMESPACES) {
      const carried = (ENTRY_NAMESPACES as readonly string[]).includes(namespace)
      expect(hasNamespaces([namespace]), namespace).toBe(carried)
    }
    expect(i18n.t(ENTRY_KEY)).toBe(wholeFr[ENTRY_KEY])
    expect(i18n.exists(PEOPLE_KEY)).toBe(false)
  })

  it('renders every entry key, and no key of another namespace, before anything is fetched', async () => {
    const { default: i18n } = await asABuildRunsIt()
    for (const key of Object.keys(wholeFr)) {
      const carried = (ENTRY_NAMESPACES as readonly string[]).includes(namespaceOfKey(key) ?? '')
      expect(i18n.exists(key), key).toBe(carried)
    }
  })

  it('fetches a namespace on request, once, and renders it from then on', async () => {
    const { default: i18n, ensureNamespaces, hasNamespaces } = await asABuildRunsIt()
    expect(() => i18n.t(PEOPLE_KEY)).toThrow('Missing message-catalogue key')
    const added = vi.spyOn(i18n, 'addResourceBundle')
    await Promise.all([ensureNamespaces(['people']), ensureNamespaces(['people', 'common'])])
    expect(hasNamespaces(['people'])).toBe(true)
    expect(i18n.t(PEOPLE_KEY)).toBe(wholeFr[PEOPLE_KEY])
    expect(added).toHaveBeenCalledTimes(1)
    await ensureNamespaces(['people'])
    expect(added).toHaveBeenCalledTimes(1)
    // Its neighbours are still not there: one namespace was asked for, one was fetched.
    expect(hasNamespaces(['invoices'])).toBe(false)
  })

  it('delivers a module only once its namespaces are there', async () => {
    const { default: i18n, withNamespaces } = await asABuildRunsIt()
    const seen: boolean[] = []
    const module = await withNamespaces(['invoices'], async () => {
      seen.push(i18n.exists('console.invoices.list.title'))
      return { marker: 'module' }
    })
    // The module was asked for at once, in parallel with its catalogue, and handed over after.
    expect(seen).toEqual([false])
    expect(module).toEqual({ marker: 'module' })
    expect(i18n.exists('console.invoices.list.title')).toBe(true)
  })

  it('refuses a namespace that has no catalogue, and says which', async () => {
    const { ensureNamespaces } = await asABuildRunsIt()
    await expect(ensureNamespaces(['nowhere' as never])).rejects.toThrow(
      'No message catalogue for "fr/nowhere".'
    )
    // A request that failed leaves nothing behind for a later change of language to trip on.
    const { default: i18n } = await import('./index')
    await expect(i18n.changeLanguage('en')).resolves.toBeTypeOf('function')
  })

  it('adds up, namespace by namespace, to the whole catalogue', async () => {
    const { default: i18n, ensureNamespaces } = await asABuildRunsIt()
    await ensureNamespaces(MESSAGE_NAMESPACES)
    expect(i18n.getResourceBundle('fr', 'translation')).toEqual(wholeFr)
  })
})

describe('in English', () => {
  it('has the entry namespaces in English once ready, and French underneath until then', async () => {
    const { default: i18n, entryCataloguesReady, hasNamespaces } = await asABuildRunsIt('en')
    expect(i18n.language).toBe('en')
    // Not ready yet: the default language answers, so nothing reads as a missing key.
    expect(hasNamespaces(ENTRY_NAMESPACES)).toBe(false)
    expect(i18n.t(ENTRY_KEY)).toBe(wholeFr[ENTRY_KEY])
    await entryCataloguesReady
    expect(hasNamespaces(ENTRY_NAMESPACES)).toBe(true)
    expect(i18n.t(ENTRY_KEY)).toBe(wholeEn[ENTRY_KEY])
    // What the screens with their own two-language copy read (`i18n.resolvedLanguage`).
    expect(i18n.resolvedLanguage).toBe('en')
  })

  it('fetches a namespace in English, and adds up to the whole English catalogue', async () => {
    const { default: i18n, ensureNamespaces } = await asABuildRunsIt('en')
    await ensureNamespaces(MESSAGE_NAMESPACES)
    expect(i18n.t(PEOPLE_KEY)).toBe(wholeEn[PEOPLE_KEY])
    expect(i18n.getResourceBundle('en', 'translation')).toEqual(wholeEn)
  })
})

describe('a change of language', () => {
  it('brings along every namespace the page already has, before the language changes', async () => {
    const { default: i18n, ensureNamespaces } = await asABuildRunsIt()
    await ensureNamespaces(['people'])
    const languages: string[] = []
    i18n.on('languageChanged', (language) => {
      // The moment every mounted screen re-renders: its text must already be there.
      languages.push(language)
      expect(i18n.t(PEOPLE_KEY)).toBe(wholeEn[PEOPLE_KEY])
      expect(i18n.t(ENTRY_KEY)).toBe(wholeEn[ENTRY_KEY])
    })
    await i18n.changeLanguage('en')
    expect(languages).toEqual(['en'])
    expect(i18n.resolvedLanguage).toBe('en')
    expect(i18n.t(PEOPLE_KEY)).toBe(wholeEn[PEOPLE_KEY])
    // And nothing the page never asked for.
    expect(i18n.exists('console.invoices.list.title')).toBe(false)
  })

  it('fetches a namespace asked for afterwards in the new language', async () => {
    const { default: i18n, ensureNamespaces } = await asABuildRunsIt()
    await i18n.changeLanguage('en')
    await ensureNamespaces(['people'])
    expect(i18n.t(PEOPLE_KEY)).toBe(wholeEn[PEOPLE_KEY])
  })
})

describe('under the unit suite', () => {
  it('has the whole catalogue in both languages without asking', async () => {
    vi.resetModules()
    const { default: i18n, hasNamespaces } = await import('./index')
    expect(hasNamespaces(MESSAGE_NAMESPACES)).toBe(true)
    expect(i18n.t(PEOPLE_KEY)).toBe(wholeFr[PEOPLE_KEY])
    expect(i18n.t(PEOPLE_KEY, { lng: 'en' })).toBe(wholeEn[PEOPLE_KEY])
  })
})
