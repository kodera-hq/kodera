// The tenant slug rule, verbatim from the pinned contract. `OrderRequest.tenant.slug`,
// `Tenant.slug`, the `slug` parameter of `GET /slug-availability`, `SlugAvailability.slug`
// and its `suggestions[]`, and `SupportTicket.tenant_context.tenant_slug` all carry it:
// 3–32 characters, a DNS label, which is also the tenant's Scaleway project name (Core
// `CONVENTIONS.md` §4). The organisation slug is a different rule — 5–20 characters, the
// name of the organisation's realm — and lives in `organisationSlug.ts`, which the login
// screen validates with (`src/features/login/discovery.ts`).
//
// A literal rather than a read from `schema.d.ts`, which carries no `pattern`.
// `tenantSlug.test.ts` holds it to the contract's own text at every location above, so
// the copy cannot drift when the pin moves. `(?![\s\S])` in place of `$` is the contract's
// spelling, kept verbatim: JSON Schema matches by search and `$` would admit a trailing
// newline.

export const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9](?![\s\S])/

export function isTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value)
}
