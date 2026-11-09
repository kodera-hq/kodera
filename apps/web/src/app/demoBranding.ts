// DEMONSTRATION ONLY. A customer's own mark beside their organisation name,
// wired so that a real deployment can never show one — because it cannot.
//
// THE CONSTRAINT, stated rather than papered over: the Core contract carries
// NO branding for an organisation. `components['schemas']['Organisation']`
// (src/api/schema.d.ts) declares `id`, `slug`, `name`, `legal_name`, `state`,
// `realm`, `country`, `vat_number`, `siren`, `vat_regime`, `billing_email`,
// `billing_address`, `email_domains` — and no logo, icon, avatar, branding or
// asset field anywhere in the file. `OrganisationSummary`, the shape `GET /me`
// actually returns to the shell, carries even less. Per-tenant branding is
// therefore not expressible today, and adding a field to the generated schema
// would be inventing a contract the server never agreed to.
//
// So this module is a registry with no product writer. Nothing in `src/`
// outside `src/mocks/` ever calls `registerDemoOrganisationMark`; the one
// caller is the demo seed (`src/mocks/demo/branding.ts`), which is reachable
// only through `src/mocks/browser.ts` — itself behind the literal
// `import.meta.env.VITE_ENABLE_MSW === '1'` gate in `src/main.tsx` that keeps
// the whole mock tree out of a production bundle
// (`scripts/check-production-bundle.sh`). In every build a customer loads this
// map is empty and `demoOrganisationMark` answers `undefined`, which is the
// honest answer until Core gains a field.
//
// Keyed by organisation SLUG, which is what the demo seed knows and what the
// shell already has in hand — not by an id the fixtures could renumber.

const marks = new Map<string, string>()

/** Called by the demo seed only. */
export function registerDemoOrganisationMark(slug: string, markUrl: string): void {
  marks.set(slug, markUrl)
}

/**
 * The demo mark for an organisation, or `undefined` — which is every
 * organisation in every build that is not a demo build.
 */
export function demoOrganisationMark(slug: string): string | undefined {
  return marks.get(slug)
}

/** Test support: the registry is module state, so a test that registers must
 * be able to put it back. */
export function clearDemoOrganisationMarks(): void {
  marks.clear()
}
