// The invitation secret, from the entry bootstrap to the claim screen, in memory only: never
// storage, history, the router or a log. A reload loses it, and the person reopens the link.

export interface ClaimEntry {
  readonly organisationId: string
  readonly organisationSlug: string
  readonly secret: string
}

let held: ClaimEntry | undefined

export function holdClaimEntry(entry: ClaimEntry): void {
  held = Object.freeze({
    organisationId: entry.organisationId,
    organisationSlug: entry.organisationSlug,
    secret: entry.secret,
  })
}

/** The held entry, only for the organisation the page's own path names. */
export function readClaimEntry(
  organisationId: string,
  organisationSlug: string
): ClaimEntry | undefined {
  return held?.organisationId === organisationId && held.organisationSlug === organisationSlug
    ? held
    : undefined
}

/** Once the claim is settled either way, the secret has no further use. */
export function forgetClaimEntry(): void {
  held = undefined
}
