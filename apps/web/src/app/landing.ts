// Where a signed-in person lands in an organisation (docs/specs/00-shell-and-login.md §3). A
// member's Home is capacity, invoices and the contract, none of it theirs: they land in Espace,
// the workspace, when the organisation has it or has no tenant yet. Espace is the `messaging`
// app; an organisation whose tenant runs without it (Visio alone, say) has no homeserver behind
// Espace, so its members land on Home, which lists the organisation's applications. Before the
// organisation has a tenant, the workspace is where a member reads how far its setup has come
// (docs/specs/11-workspace.md §4.3), so they land there rather than on an empty Home that speaks
// to an owner. Owners, admins and billing keep Home. `landingIn` (`organisationLanding.ts`) reads
// the organisation's applications for this choice.
import type { components } from '../api/schema'

type OrganisationRole = components['schemas']['OrganisationRole']
type AppCode = components['schemas']['AppCode']

export type Landing = '/$org/home' | '/$org/workspace'

/**
 * `apps`: the tenant's application codes; `null` when the organisation has no tenant yet;
 * `undefined` when they could not be read, which keeps Home: the workspace is never chosen on a
 * guess.
 */
export function landingFor(
  role: OrganisationRole | undefined,
  apps: readonly AppCode[] | null | undefined
): Landing {
  if (role !== 'org_member') return '/$org/home'
  return apps === null || apps?.includes('messaging') === true ? '/$org/workspace' : '/$org/home'
}
