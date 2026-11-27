import { isOrganisationSlug } from '../api/organisationSlug'

const knownSharedRealmSlugs = new Set<string>()
const SHARED_REALM_SLUGS_KEY = 'kodera.web.auth.sharedRealmSlugs'
const MAX_SHARED_REALM_SLUGS = 64
let sharedRealmSlugsHydrated = false

function addSharedRealmSlug(slug: unknown): void {
  if (typeof slug !== 'string' || slug === 'community' || !isOrganisationSlug(slug)) return
  knownSharedRealmSlugs.delete(slug)
  knownSharedRealmSlugs.add(slug)
  if (knownSharedRealmSlugs.size > MAX_SHARED_REALM_SLUGS) {
    knownSharedRealmSlugs.delete(knownSharedRealmSlugs.values().next().value!)
  }
}

function persistSharedRealmSlugs(): void {
  try {
    window.sessionStorage.setItem(
      SHARED_REALM_SLUGS_KEY,
      JSON.stringify([...knownSharedRealmSlugs])
    )
  } catch {
    // Browser storage policy must not prevent in-memory session hints.
  }
}

function hydrateSharedRealmSlugs(): void {
  if (sharedRealmSlugsHydrated) return
  sharedRealmSlugsHydrated = true
  try {
    const stored: unknown = JSON.parse(
      window.sessionStorage.getItem(SHARED_REALM_SLUGS_KEY) ?? 'null'
    )
    if (Array.isArray(stored)) {
      for (const slug of stored) addSharedRealmSlug(slug)
      persistSharedRealmSlugs()
    }
  } catch {
    // Malformed JSON and unavailable storage leave the in-memory hints usable.
  }
}

export function rememberSharedRealmSlug(slug: string): void {
  if (slug === 'community' || !isOrganisationSlug(slug)) return
  hydrateSharedRealmSlugs()
  addSharedRealmSlug(slug)
  persistSharedRealmSlugs()
}

export function forgetSharedRealmSlug(slug: string): void {
  hydrateSharedRealmSlugs()
  knownSharedRealmSlugs.delete(slug)
  persistSharedRealmSlugs()
}

export function isKnownSharedRealmSlug(slug: string): boolean {
  hydrateSharedRealmSlugs()
  return knownSharedRealmSlugs.has(slug)
}

export function clearKnownSharedRealmSlugs(): void {
  knownSharedRealmSlugs.clear()
  // Do not rehydrate old hints if removal is refused by browser storage policy.
  sharedRealmSlugsHydrated = true
  try {
    window.sessionStorage.removeItem(SHARED_REALM_SLUGS_KEY)
  } catch {
    try {
      window.sessionStorage.setItem(SHARED_REALM_SLUGS_KEY, '[]')
    } catch {
      // Sign-out still clears memory when both storage operations are unavailable.
    }
  }
}
