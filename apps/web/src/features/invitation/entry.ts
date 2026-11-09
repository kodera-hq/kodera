// The invitation secret, from the entry bootstrap to the acceptance screen, in memory only: never
// storage, history, the router or a log (docs/specs/12-invitation-accept.md §3). A reload loses
// it, and the person reopens the link.

export interface InvitationEntry {
  readonly organisationId: string
  readonly organisationSlug: string
  readonly secret: string
}

let held: InvitationEntry | undefined

export function holdInvitationEntry(entry: InvitationEntry): void {
  held = Object.freeze({
    organisationId: entry.organisationId,
    organisationSlug: entry.organisationSlug,
    secret: entry.secret,
  })
}

/** The held entry, only for the organisation the page's own path names. */
export function readInvitationEntry(
  organisationId: string,
  organisationSlug: string
): InvitationEntry | undefined {
  return held?.organisationId === organisationId && held.organisationSlug === organisationSlug
    ? held
    : undefined
}

/** Once the invitation is settled either way, the secret has no further use. */
export function forgetInvitationEntry(): void {
  held = undefined
}

/** Forgets `entry` only while it is the one held: a page leaving forgets its own secret, never a
 * newer one held since. */
export function forgetInvitationEntryIfHeld(entry: InvitationEntry): void {
  if (held === entry) held = undefined
}
