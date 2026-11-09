// The organisation slug rule, verbatim from the pinned contract. `RealmDiscoveryRequest.slug`,
// `OrganisationSummary.slug`, `Organisation.slug`, `OrganisationCreateRequest.slug`,
// `OrganisationBootstrap.slug` and, since contract 0.12.0, the realm discovery answer's slug and
// realm members all carry it: 5–20 characters, lowercase alphanumerics with internal hyphens and
// alphanumeric ends, which is also the name of the organisation's realm.
// The tenant slug is a different rule — 3–32 characters, a DNS label — and lives in
// `tenantSlug.ts`.
//
// A literal rather than a read from `schema.d.ts`, which carries no `pattern`.
// `organisationSlug.test.ts` holds it to the contract's own text at every location above, and
// checks that no other slug-shaped rule has appeared, so the copy cannot drift when the pin
// moves. `(?![\s\S])` in place of `$` is the contract's spelling, kept verbatim: JSON Schema
// matches by search and `$` would admit a trailing newline.

export const ORGANISATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{3,18}[a-z0-9](?![\s\S])/

export function isOrganisationSlug(value: string): boolean {
  return ORGANISATION_SLUG_PATTERN.test(value)
}
