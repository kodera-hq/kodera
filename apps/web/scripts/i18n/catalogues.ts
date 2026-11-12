// The namespace catalogues as the browser loads them (`src/i18n/catalogues/<locale>/<namespace>.json`),
// read back from disk and checked for the faults a split can introduce and a single file could not:
// a namespace one locale has and the other lacks, a key one locale's namespace has and the other's
// lacks, a key filed under a namespace other than the one its name says, and a namespace set that
// no longer adds up to the whole catalogue.
//
// The generator (`generate.ts`) writes all of these files in one pass, so none of the above can
// come out of `npm run i18n:generate`. They come from a hand edit, a half-resolved merge or a stale
// tree, which is exactly when nothing else would notice: the unit suite reads the whole catalogue,
// not the split one.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Catalogue = Record<string, string>
export const LOCALES = ['fr', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export type NamespaceCatalogues = Record<Locale, Record<string, Catalogue>>

export function readNamespaceCatalogues(directory: string): NamespaceCatalogues {
  const catalogues: NamespaceCatalogues = { fr: {}, en: {} }
  for (const locale of LOCALES) {
    const localeDirectory = join(directory, locale)
    if (!existsSync(localeDirectory)) continue
    for (const name of readdirSync(localeDirectory).sort()) {
      if (!name.endsWith('.json')) continue
      catalogues[locale][name.slice(0, -'.json'.length)] = JSON.parse(
        readFileSync(join(localeDirectory, name), 'utf8')
      ) as Catalogue
    }
  }
  return catalogues
}

/** Every key of one locale, whichever namespace file holds it. */
export function unionOf(namespaces: Record<string, Catalogue>): Catalogue {
  const union: Catalogue = {}
  for (const catalogue of Object.values(namespaces)) Object.assign(union, catalogue)
  return union
}

export interface CatalogueCheckInput {
  catalogues: NamespaceCatalogues
  /** The namespaces the runtime knows (`src/i18n/namespaces.ts`, `MESSAGE_NAMESPACES`). */
  declared: readonly string[]
  /** The whole catalogues (`src/i18n/{fr,en}.json`), which the split must add up to. */
  whole: Record<Locale, Catalogue>
}

export function checkNamespaceCatalogues(input: CatalogueCheckInput): string[] {
  const problems: string[] = []
  const { catalogues, declared, whole } = input
  const names = new Set([...Object.keys(catalogues.fr), ...Object.keys(catalogues.en)])

  for (const namespace of [...names].sort()) {
    const fr = catalogues.fr[namespace]
    const en = catalogues.en[namespace]
    if (fr === undefined || en === undefined) {
      const [has, lacks] = fr === undefined ? ['en', 'fr'] : ['fr', 'en']
      problems.push(`namespace "${namespace}" has a ${has} catalogue and no ${lacks} one`)
      continue
    }
    for (const key of Object.keys(fr).sort()) {
      if (!(key in en)) {
        problems.push(`key in fr/${namespace}.json is missing from en/${namespace}.json: ${key}`)
      }
    }
    for (const key of Object.keys(en).sort()) {
      if (!(key in fr)) {
        problems.push(`key in en/${namespace}.json is missing from fr/${namespace}.json: ${key}`)
      }
    }
  }

  for (const locale of LOCALES) {
    const seen = new Map<string, string>()
    for (const [namespace, catalogue] of Object.entries(catalogues[locale])) {
      for (const key of Object.keys(catalogue)) {
        const expected = /^console\.([a-z]+)\./.exec(key)?.[1]
        if (expected !== namespace) {
          problems.push(
            `${locale}/${namespace}.json holds a key of another namespace (${expected ?? 'none'}): ${key}`
          )
        }
        const earlier = seen.get(key)
        if (earlier !== undefined) {
          problems.push(`${locale}: ${key} is in both ${earlier}.json and ${namespace}.json`)
        }
        seen.set(key, namespace)
      }
    }
    const union = unionOf(catalogues[locale])
    for (const key of Object.keys(whole[locale]).sort()) {
      if (!(key in union)) {
        problems.push(
          `key in ${locale}.json is in no ${locale} namespace catalogue (run npm run i18n:generate): ${key}`
        )
      } else if (union[key] !== whole[locale][key]) {
        problems.push(
          `${locale}.json and its namespace catalogue disagree on the text of (run npm run i18n:generate): ${key}`
        )
      }
    }
    for (const key of Object.keys(union).sort()) {
      if (!(key in whole[locale])) {
        problems.push(
          `key in a ${locale} namespace catalogue is not in ${locale}.json (run npm run i18n:generate): ${key}`
        )
      }
    }
  }

  const declaredSet = new Set(declared)
  for (const namespace of [...names].sort()) {
    if (!declaredSet.has(namespace)) {
      problems.push(
        `namespace "${namespace}" has catalogues and is not listed in MESSAGE_NAMESPACES (src/i18n/namespaces.ts)`
      )
    }
  }
  for (const namespace of [...declaredSet].sort()) {
    if (!names.has(namespace)) {
      problems.push(
        `namespace "${namespace}" is listed in MESSAGE_NAMESPACES (src/i18n/namespaces.ts) and has no catalogue`
      )
    }
  }
  return problems
}
