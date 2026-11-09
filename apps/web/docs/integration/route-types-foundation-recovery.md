# Route inference foundation reconciliation

Status: Specified before integration

Normally merge recovered analytics6192adbc7aa68db577f38b99ed212186491a9c06 into existing route-inference fix f33cbafbf436696ed3720d927f29a77414c356ec. Preserve original two-file route change, inferred loader/parameter types and mock-provider exclusion. All other shell and analytics files must remain unchanged.

Before integration, `git merge-base --is-ancestor 6192adbc7aa68db577f38b99ed212186491a9c06 HEAD` must fail. Afterward it must pass. `git diff --exit-code f33cbaf -- src/app/routeTree.ts src/app/routeTree.types.test.tsx` must pass. Final delta includes only those files and this record. Run focused route tests, typecheck, full unit/static/build validation. Independently weaken the exact return-type annotation to AnyRoute in a temporary copy and require the type gate to fail with the expected any inference error, then restore.

No new route behavior, dependencies, workflow changes or production identity claims. Separate expert review precedes publication.

## Result

The initial ancestor check failed; the normal merge was clean. Both original
route files are byte-identical to the existing fix, and every other inherited
file matches the recovered analytics/shell base. All 811 tests pass, along with
types, formatting and the application build; lint retains one inherited
DocumentViewer unused-disable warning with no errors.

An independent temporary-copy mutation changed the conditional route return
annotation back to AnyRoute. Type checking failed at all three intended loader,
membership and parameter assertions (TS2322), in addition to the now-unused
precise type alias. The original files were never mutated. This proves the type
gate detects erased inference on the recovered dependency set.
