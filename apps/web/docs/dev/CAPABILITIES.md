# Capabilities Core does not serve yet

Status: in force for the pilot.

Some console screens are built against the contract but call operations that Core does not route yet. Each such call would answer 404 or 405, and the person would see an error. The pilot hides these screens instead. **One switch decides it: `src/app/capabilities.ts`.** Do not write a separate condition anywhere else.

| Capability | Operations | Hidden while unserved |
|---|---|---|
| `on-site-enrolment` | `listEnrolmentTokens`, `createEnrolmentToken`, `revokeEnrolmentToken` | People › « Accès sur site » tab and invite-menu item; `/people/on-site` opens the member list. With the import also hidden, « Inviter » opens the e-mail invitation directly |
| `member-import` | `createMemberImport`, `getMemberImport`, `patchMemberImport`, `executeMemberImport` | People › CSV import (empty state and invite menu), and the copy that mentions it (the empty state's body, the too-many-addresses error); the « Préparer la liste de vos collaborateurs » link on Home, Status and the order confirmation; `/people/import` and `/people/import/{id}` open the member list |
| `status-components` | `listStatusComponents` | Status › « État du service » card (the pill and banner read the tenant status itself); the capacity card then takes the full row |
| `status-incidents` | `listIncidents` | Status › incident drawer: a degraded pill is plain text, and the degraded banner carries « Nous écrire » instead |
| `availability-history` | `listTenantAvailability` | Status › « Historique sur sept jours » drawer and its link |
| `domain-addresses` | `listDomains` | Domain › the address list; the page shows « Cette page n'est pas encore disponible. » |

`useEntitlementsQuery` and Home's `useAvailabilityQuery` had no caller and are removed. With them, the console no longer calls `listEntitlements` or Home's `listTenantAvailability`.

## How a surface uses it

`offers(capability)` answers whether this build offers the capability.
- When it does not, the surface draws nothing, or it sends the person to the nearest screen that works.
- Each read hook (`useQuery`) carries `enabled: offers(…)` as well, so a screen that mounts one anyway sends nothing. The writes, and `ImportScreen`'s direct `fetchQuery`, have no gate of their own: they run only from the hidden screens, so a new screen must not call them without asking `offers()` first.

## When Core routes one

1. Bump the vendored contract.
2. Set the capability's `served: true` in the same change.
3. Remove its operations from `UNROUTED_FOR_THE_PILOT` in `tests/unit/app/capabilities.test.ts`.
4. Update the pilot tests, which assert the surface hidden. The visual baselines and end-to-end specs already show it: they run the mock build with the override.

## The guard

`tests/unit/app/capabilities.test.ts` reads every Core call in `src/`. It uses the TypeScript syntax tree, maps each call to its contract `operationId`, and fails when any of these is true:
- an unserved operation is called from a module the table does not name for it;
- an operation the staging walk found unrouted is called and is not behind an unserved capability;
- the table names an operation the contract lacks, or a caller that does not call it;
- a call it cannot read: a `coreApi()` not called as `coreApi().VERB('path')`, or a `mutate()` whose route is not an inline object literal.

It locates the fetch functions, not the screens that use their read hooks; those hooks' own `enabled` gate covers the screens. Self-tests add a stray caller, and calls it cannot read, and assert that the guard names each.

`src/app/capabilities.pilot.test.tsx` and `src/features/people/PeopleArea.pilot.test.tsx` render the pilot build and check two things:
- each hidden surface is absent;
- MSW records no request to an unserved path.

## Mock builds

MSW answers every contract operation, so a mock build may show these screens. The end-to-end and visual suites do, and so does the unit suite by default (`vitest.config.ts`), so that they keep exercising the built screens.

A mock build shows them only when it sets **both** `VITE_ENABLE_MSW=1` and `VITE_MOCK_UNSERVED=1`:
- `playwright.config.ts` sets both.
- The demo (`docs/dev/DEMO.md`) does not, so it shows the pilot.
- A build that talks to a real Core has `VITE_ENABLE_MSW` unset or `0` (the Dockerfile pins it), so `VITE_MOCK_UNSERVED` alone never shows an unrouted screen.
