# ADR-0005: Routing and server state — a typed router with a code-based route tree, and a query cache

**Status:** Accepted; superseded in part by ADR-0010 for owner-claim consume dispatch only, effective after its configured-enforcement and acceptance gates
**Date:** 2026-09-02
**Deciders:** the crew

## Context

Product code starts now and `docs/dev/BASELINE.md`, which is frozen, names neither a router nor a server-state library. Both are chosen once, before the seven launch areas are built in parallel, or each area invents its own.

**The URL carries state the specs depend on.** Every screen lives under an organisation slug, `/{org}/…`, and the flow specs address sub-state through the query string and the fragment: `?tab=`, `?help=1`, `?org=`, `#pay`. An untyped `useParams()` hands back `string | undefined` and a hand-parsed `URLSearchParams` hands back `string | null`; under `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` both spread defensive checks through every screen, and neither says anything when a link is built with a parameter the target route stopped reading. The wrong `?tab=` renders the default tab with no error — the silent shape of failure every gate in this repository exists to make loud.

**Reads are polled, on rules the specs already write down.** Provisioning status refreshes on an interval rather than on a click. That belongs to one library with one set of semantics, not to a `setInterval` per screen that keeps running after unmount and after the tab is hidden.

**Several builders add areas at once.** Anything generated into a single shared file becomes a merge hotspot, and a regenerated file is the worst kind: the conflict is in code nobody wrote.

## Decision

**A typed router with a code-based route tree, and a query cache that owns every server read.** Concretely: TanStack Router and TanStack Query.

Routing:

- **Path parameters are typed.** The organisation segment `/{org}/…` reaches a screen as a typed `org`, never as `string | undefined`.
- **Search parameters are validated with zod, per route.** `?tab=`, `?help=1` and `?org=` are declared and zod-validated by the route that reads them; an unparseable value is rejected at the route boundary instead of falling through to a default. `#pay` is not a search parameter and carries no schema: the route that uses it reads `location.hash` directly and switches on it as a plain string.
- **The route tree is code-based.** One `routes.ts` per area under `src/features/<area>/`, aggregated in `src/app/routeTree.ts` with **one import line per area**. A reviewer can check this directly: a PR that adds an area adds exactly one line to `src/app/routeTree.ts` and declares its routes in its own directory. No generated `routeTree.gen.ts` is committed, and no route is declared outside its area's `routes.ts`.

Server state:

- **Every server read goes through the query cache.** No component fetches, and no screen parks a response in `useState`.
- **Polling rules come from the specs, as configuration.** Status refreshes every **30 s** while active and every **10 s** while provisioning, **never while the tab is hidden**, and backs **off to 2 min after three consecutive failures**. Retries, cache lifetimes and invalidation after a mutation are configured in one place, not per screen.
- **Mutations go through `src/api/mutations.ts`**, a thin seam over the generated client (`docs/dev/API_CLIENT.md`). It is the one place that will add `If-Match` when the contract declares it.

## Options considered

| Option | Why not |
|---|---|
| **Chosen: TanStack Router (code-based tree) + TanStack Query** | Typed path params and zod-validated search are the point; the query cache's `refetchInterval`, `enabled` and retry semantics express the specs' polling rules as configuration rather than as effects. Costs two new surfaces to learn. |
| File-based routing with a generated `routeTree.gen.ts` | Same router, less wiring. Rejected: the generated tree is one file every area touches, so it is a merge hotspot for builders working in parallel, and a conflict inside generated code is resolved by regenerating and re-reviewing rather than by reading a diff. |
| react-router 7, library mode | Params and search are untyped, which is the failure this decision exists to remove. Its framework mode is not on the table either: it contradicts the single-page baseline and the prerendered-hub split of ADR-0001. |
| wouter | Small and quick. Rejected: no typed search parameters and no loaders, so the URL state the specs lean on stays hand-parsed. |
| SWR | A capable fetch cache. Rejected: the polling rules would be reassembled by hand on each screen instead of being declared once per resource. |
| Redux Toolkit Query | Rejected: it brings a store the console does not need. Server state is the only shared state here and it already has an owner. |

## Consequences

- **The browser URL keeps the organisation slug, never its id.** The console resolves slug → id once, from `GET /me` (`kodera-server/contracts/CONSOLE_RECONCILIATION.md` §4.1), and sends the id to the API. A route that puts an id in the URL is a review comment.
- Search-parameter schemas are the same zod schemas the forms use (ADR-0006), so the validation vocabulary is shared rather than doubled.
- Polling becomes testable. Each resource's rules sit in one query-options object that a unit test can assert, instead of being spread across effects that only misbehave in a long-running tab.
- Two dependency surfaces to learn, and route files that must stay close to the specs they serve.
- **Repository layout for mocks and end-to-end specs**, settled here because the router fixes where feature code lives:
  - end-to-end specs at `tests/e2e/*.spec.ts`;
  - generated MSW handlers at `src/mocks/generated/`, never hand-edited;
  - hand-written scenario overlays at `src/mocks/overlays/<area>.<condition>.ts`, discovered with `import.meta.glob` — no registry file, so adding an overlay is never a merge conflict;
  - the helper `tests/e2e/support/useScenario.ts` activates overlays by name through `sessionStorage['msw:scenarios']`.

  Overlays live under `src/` because Vite must bundle them for both the preview build and Storybook. `docs/dev/TESTING.md` is updated to match.
- Revisit if the aggregation file in `src/app/routeTree.ts` turns into the merge hotspot the code-based tree was chosen to avoid, or if typed search parameters prove unworkable under `exactOptionalPropertyTypes`. The fallback for the first is per-area lazy route registration, never a generated tree.
