# People resend retries and mock concurrency

Status: Bounded implementation of the existing POST/ETag contract. Existing catalogue wording and later product decisions remain unchanged.

## Defects and scope

Both pending-member and Invitations-tab resend actions rely on the client's per-request fallback key. If the server sends the email but its reply is lost, clicking resend again sends a new intention key and can deliver an extra email. Keep one key for the unresolved invitation resend intention across retries and between both tabs. Scope it by organisation and invitation within the current QueryClient session. Store only that key in memory; clear it after a successful POST response, so a later deliberate resend is a new intention. QueryClient clearing ends the session. No storage, new copy, global API middleware change or new endpoint is introduced.

The People mock checks only the presence of If-Match on membership and import mapping PATCHes. Compare the supplied tag with the current resource tag before modifying data or incrementing its version. A missing tag retains 428 precondition-required; a stale tag returns 412 precondition-failed with both current_etag and ETag. Successful writes advance the version. These are mock-fidelity corrections, not backend authorisation or persistence implementation.

Concurrent PATCHes with the same original tag must not both succeed. Body parsing yields to other requests, so compare the fresh current tag again after parsing and immediately before synchronous validation/mutation/version advancement. Preserve the early missing/stale-tag refusals before body parsing, including malformed bodies. No await may separate the final comparison from the write.

The resend mock must replay the first successful response for the same invitation/key without incrementing sent_count again. Keep a snapshot, so another deliberate send does not mutate an earlier response. Different keys represent different sends. The endpoint has no request body; no broader POST replay engine is introduced.

## Runnable acceptance before code

Add focused tests first, using the real Core client and stateful MSW People handlers:

1. From each of the two resend controls, simulate the server completing the first send while the response is lost. Retry and assert the request keys are equal and nonempty, and the actual invitation sent_count increases once only. After confirmed success, another deliberate send must have a new key and increase the counter once more.
2. Fail a pending-member resend, switch to Invitations and retry the same invitation. The key and single-send guarantee must survive the panel change.
3. Directly replay a resend key after another successful intention and assert the original immutable response is returned without another send.
4. Read a membership tag, write with it once, then PATCH with that now-stale tag. Assert 412, current_etag and ETag, and re-read unchanged role/version. Also assert missing If-Match remains 428.
5. Perform the equivalent import-mapping stale-tag test and verify its mapping/default-role/version remain unchanged; missing If-Match remains 428.
6. Synchronize two membership PATCH body parses with the same tag and distinct requested roles. Assert exactly one 200 and one 412, the rejected response's current tag equals the winner's tag, and a reread contains only the winner's role with exactly one version advancement. Repeat for distinct import mappings/default roles. The synchronization must reproduce the original pre-parse comparison race and an intended mutation that restores it.

Run the tests against unchanged implementation and retain failures at the key, counter or stale-response assertions. Correct the bounded code, run the same acceptance, then prove selected intended-defect mutations fail at those assertions. Reuse existing dependencies; no installs or browser suites.

```sh
./node_modules/.bin/vitest run src/features/people/resendInvitation.test.tsx tests/unit/mocks/people-preconditions.test.ts --maxWorkers=1
```

Run related People feature and overlay-contract unit tests, typecheck, changed-path lint/format and the canonical attribution/required-clauses checks. Preserve the primary clone and all other lane source. Commit on the feature branch for integration; publication waits for the lead's single-Console-CI sequence and independent source review.

## Explicit triage

The caller's own row already offers no row menu and an existing test verifies that, consistent with current MembershipDetail rendering advice. No caller-row change is included without a new reproduced defect. Search deliberately narrows loaded pages because the contract defines no search parameter; broader search needs a product/API decision. The missing-QR overlay is the explicit partial-failure scenario in 03-people.md section 7; ordinary seeds provide QR data. Neither is treated as evidence of backend readiness or corrected with invented copy.
