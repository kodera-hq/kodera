// The areas whose route still renders `AreaStub` and nothing else. A leaf of its own, imported by
// the stub itself and by every screen that would otherwise offer a way into one: a screen deep in
// the workspace must be able to ask this without pulling the shell's own module into its chunk.
//
// A screen that offers a way into one of these sends the member to a heading and a sentence saying
// it is not there yet, which is a dead end — it reads as something broken rather than as something
// not built. `tests/unit/app/area-stub-links.test.ts` holds this list to the two route files that
// render the stub: `features/security/routes.tsx` and `features/federation/routes.tsx`.

export const STUB_AREAS = ['security', 'federation'] as const
export type StubArea = (typeof STUB_AREAS)[number]

/** Whether `/$org/{area}` renders nothing but the stub today. */
export function isStubArea(area: string): boolean {
  return (STUB_AREAS as readonly string[]).includes(area)
}
