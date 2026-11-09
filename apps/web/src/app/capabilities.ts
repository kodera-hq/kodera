// What this console offers that needs a Core operation Core does not route yet: the one switch
// (docs/dev/CAPABILITIES.md).
//
// Each capability below is a screen or a part of one whose code is built, against the contract,
// but whose operations Core does not serve: a call would answer 404 or 405 and the customer would
// see an error. The pilot hides them instead. A surface asks `offers(capability)` and draws
// nothing, or sends the person to the nearest screen that works, when the answer is no. Each read
// hook (`useQuery`) also carries `enabled: offers(…)`, so a screen that mounts one anyway sends
// nothing. The writes, and `ImportScreen`'s direct `fetchQuery`, have no gate of their own: they run
// only from the screens hidden here.
//
// When Core routes a capability's operations, set its `served` to true here, in the same change
// that bumps the vendored contract. `tests/unit/app/capabilities.test.ts` keeps this table honest:
// every fetch the console writes for one of these operations sits in a module this table names, and
// each listed operation is one the contract defines. It locates the fetch functions and their hooks,
// not the screens that use the read hooks: those hooks' own `enabled` gate covers the screens.
//
// A mock build may still show them all, because MSW answers every contract operation: the
// end-to-end and visual suites keep exercising the built screens. That needs BOTH
// `VITE_ENABLE_MSW=1` and `VITE_MOCK_UNSERVED=1`. A build that talks to a real Core has
// `VITE_ENABLE_MSW` unset or `0` (the Dockerfile and `scripts/check-production-bundle.sh` hold it
// there), so `VITE_MOCK_UNSERVED` alone can never put an unrouted call in front of a customer.
// Each variable is read as a literal `import.meta.env.VITE_…` access so Vite folds it at build
// time (src/config.ts explains why).

import type { operations } from '../api/schema'

export type OperationId = keyof operations

export type Capability =
  | 'on-site-enrolment'
  | 'member-import'
  | 'status-components'
  | 'status-incidents'
  | 'availability-history'
  | 'domain-addresses'

export interface CapabilityRow {
  /** Whether Core routes every operation below. False: the pilot hides the surface. */
  served: boolean
  /** The contract operations the surface calls. */
  operations: readonly OperationId[]
  /** The modules that call them, relative to `src/`. Every call site must be in one of these. */
  callers: readonly string[]
  /** What the person sees instead while it is not served. */
  hidden: string
}

export const CAPABILITIES: Readonly<Record<Capability, CapabilityRow>> = {
  'on-site-enrolment': {
    served: false,
    operations: ['listEnrolmentTokens', 'createEnrolmentToken', 'revokeEnrolmentToken'],
    callers: ['features/people/queries.ts', 'features/people/OnSitePanel.tsx'],
    hidden:
      'People has no « Accès sur site » tab or invite menu item; /people/on-site opens the member list.',
  },
  'member-import': {
    served: false,
    operations: [
      'createMemberImport',
      'getMemberImport',
      'patchMemberImport',
      'executeMemberImport',
    ],
    callers: ['features/people/memberImport.ts'],
    hidden:
      'People offers no CSV import; the « prepare your people » link on Home, Status and the order ' +
      'confirmation is not drawn; /people/import and /people/import/{id} open the member list.',
  },
  'status-components': {
    served: false,
    operations: ['listStatusComponents'],
    callers: ['features/status/queries.ts'],
    hidden: 'Status draws no components card. The pill and banner read the tenant status itself.',
  },
  'status-incidents': {
    served: false,
    operations: ['listIncidents'],
    callers: ['features/status/queries.ts'],
    hidden:
      'Status draws no incident detail: a degraded pill is plain text, and the banner names the ' +
      'component and since when, from the tenant status, and offers « Nous écrire ».',
  },
  'availability-history': {
    served: false,
    operations: ['listTenantAvailability'],
    callers: ['features/status/queries.ts'],
    hidden: 'Status draws no seven-day history drawer (its link sits on the components card).',
  },
  'domain-addresses': {
    served: false,
    operations: ['listDomains'],
    callers: ['features/domain/queries.ts'],
    hidden:
      "Domain shows its heading and « Cette page n'est pas encore disponible. », with no address list.",
  },
}

/** Whether this build offers `capability`: Core serves it, or a mock build asked to show it. */
export function offers(capability: Capability): boolean {
  if (CAPABILITIES[capability].served) return true
  return import.meta.env.VITE_ENABLE_MSW === '1' && import.meta.env.VITE_MOCK_UNSERVED === '1'
}
