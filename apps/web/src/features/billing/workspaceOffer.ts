// Pure helpers for the unified `workspace` pack and Core snapshot capacity guides.
// Never computes VAT percentages or derives amounts from mutable client state.

import type { components } from '../../api/schema'
import type { BillingLocale } from './billingMessages'

export type Pack = components['schemas']['Pack']
export type CapacityTier = components['schemas']['CapacityTier']
export type AppCode = components['schemas']['AppCode']
export type Subscription = components['schemas']['Subscription']
export type PriceSnapshot = components['schemas']['PriceSnapshot']

export const UNIFIED_WORKSPACE_PACK_CODE = 'workspace'

const DECIMAL_GB = 1_000_000_000
const DECIMAL_MB = 1_000_000
const BINARY_GIB = 1_073_741_824
const BINARY_MIB = 1_048_576
const BINARY_KIB = 1_024

/**
 * Selects the base catalogue pack for plan comparison:
 * 1. If a base non-Docs pack (`visio`) is available alongside a separate Docs pack, keep that split.
 * 2. When the catalogue sells the unified `workspace` pack (`messaging`, `visio`, `docs`), return it.
 * 3. Otherwise fall back to the first available pack, or `packs[0]`.
 */
export function selectCatalogueBasePack(packs: readonly Pack[]): Pack | undefined {
  const withoutDocs = packs.find((pack) => pack.available && !pack.apps.includes('docs'))
  if (withoutDocs !== undefined) return withoutDocs
  return (
    packs.find((pack) => pack.available && pack.code === UNIFIED_WORKSPACE_PACK_CODE) ??
    packs.find((pack) => pack.available) ??
    packs[0]
  )
}

/**
 * Formats byte capacities and quota counters without floating-point drift.
 * Catalogue `storage_included_bytes` uses exact decimal gigabytes (e.g. 50_000_000_000 -> 50 Go / 50 GB),
 * while arbitrary attachment counters format cleanly across binary/decimal magnitudes.
 */
export function formatByteCapacity(bytes: number, locale: BillingLocale): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0
  const unitGb = locale === 'fr' ? 'Go' : 'GB'
  const unitMb = locale === 'fr' ? 'Mo' : 'MB'
  const unitKb = locale === 'fr' ? 'Ko' : 'KB'
  const unitB = locale === 'fr' ? 'o' : 'B'
  const sep = locale === 'fr' ? '\u00a0' : ' '
  const fmt = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    maximumFractionDigits: 1,
  })

  if (safe === 0) return `0${sep}${unitMb}`
  if (safe >= DECIMAL_GB && safe % DECIMAL_GB === 0) {
    return `${fmt.format(safe / DECIMAL_GB)}${sep}${unitGb}`
  }
  if (safe >= BINARY_GIB) {
    return `${fmt.format(safe / BINARY_GIB)}${sep}${unitGb}`
  }
  if (safe >= DECIMAL_GB) {
    return `${fmt.format(safe / DECIMAL_GB)}${sep}${unitGb}`
  }
  if (safe >= DECIMAL_MB && safe % DECIMAL_MB === 0) {
    return `${fmt.format(safe / DECIMAL_MB)}${sep}${unitMb}`
  }
  if (safe >= BINARY_MIB) {
    return `${fmt.format(safe / BINARY_MIB)}${sep}${unitMb}`
  }
  if (safe >= BINARY_KIB) {
    return `${fmt.format(safe / BINARY_KIB)}${sep}${unitKb}`
  }
  return `${fmt.format(safe)}${sep}${unitB}`
}
