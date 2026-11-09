# Customer directory image acceptance

Status: Core image qualification passed; bounded bridge completion correction under source acceptance.
Owner: Core

## Scope

One fixed directory scenario extends the existing customer HTTP controller; it never owns a second build/database/provider/cleanup implementation. The default `/me` qualification remains intact. The scenario uses the actual allowlisted image, one disposable PostgreSQL/provider/API chain, real authorization-code/S256 tokens, and a SELECT-only API role. No product endpoint, model, migration, contract, image input, dependency, signing-key provisioning or deployed identity change is included. Synthetic fixture logins do not qualify MFA or production readiness.

## Fixture and acceptance

Exactly26 eligible primary-organisation relationships force limit25 continuation while fitting the default50 page. Three excluded relationships exercise removed/deleted membership/deleted person rules; a disabled person remains descriptive. Customer slug and realm pairs are `directory-main` and `directory-other`. All membership IDs are distinct; the foreign organisation relationship belongs to the SAME persisted primary person. A second active primary owner preserves the database owner guard during caller role/revocation changes; the foreign relationship is its organisation's active owner. Seeds use real model/migration constraints, accepted_at/deletion pairs and permanent slug reservations. Expected projections use fixed seed values and independent database readback, never endpoint serializers/selectors or HTTP output.

Qualify exact `/me`, detail and directory projections; unknown provider/MFA/activity fields stay omitted. Walk limit1 and limit25 continuation with exact rows/no duplicates, no-store/correlation/no collection ETag. Recheck current role/grant, same-token revocation and conditional reads; wrong audience/issuer/nonaccess material refuse401, verified staff/billing/revoked grants403, foreign target404 and cursor tamper/rebinding400. A fresh valid token for the same principal may continue. Missing cursor key fails only directory500; `/me` and detail remain usable. Commit synthetic contact/organisation changes and observe current values, then restore.

The real DB pause must yield safe correlated500 for all three reads, ready503/live200, and same-process persisted recovery. This is separate from the hosted client stopping/restarting the exact API container and observing its real NetworkError. Snapshot all five authority tables around GET batches; no endpoint writes are allowed. Preserve actual SELECT-only catalogue and READ WRITE SQLSTATE42501 probes. A changed fixture count cannot weaken those privileges.

## Resource and bridge contract

Require a separately written runtime admission bound to the exact clean source head/tree and evidence destination. Stop heavy work below15GiB and warn below30GiB. Use existing immutable image pins without pulls, loopback dynamic ports, bounded memory/CPU/tmpfs and no persistent volumes. Record immutable images and exact resource IDs/labels immediately after creation; check both before each mutation and cleanup. Cleanup attempts every owned resource even after failures and never removes an identity mismatch.

A fixed optional bridge child stays inside this same controller lifecycle. Lead independently binds its manifest, clean Console head and harness inventory hash. Its anonymous inherited fd3/fd4 pipes carry only bounded JSON lines (256KiB), sequential ids and fixed parameterless operations: reset, token-valid, token-expired, rename-organisation, restore-organisation, revoke-caller, restore-caller, stop-api, start-api. No arbitrary command, target, SQL, URL or credential is accepted. Tokens never enter files, argv, environment, stdout/stderr or evidence. Parent restores state and cleans resources on child failure, EOF, protocol failure or timeout, even if a restoration attempt fails.

Prepare an originally verified legitimate token from the fixture's short-lived public PKCE client. Wait for actual exp plus30-second verifier leeway while performing other qualification; no clock/claim bypass. Expired reply includes flow, issuer, exp and leeway provenance. Issue separate normal-lifetime valid tokens; do not replace the valid token between first cursor and revoked/restore requests. The bridge is a production-client read proof only, excluding browser OIDC, discovery, CORS, full screens and deployed release qualification.

## Runnable gates

Before runtime implementation, the named controller/fixture tests must fail for missing scenario capability. Pure acceptance needs no service:

```sh
python -m pytest -q tests/test_membership_directory_image_controller.py tests/test_customer_http_controller.py tests/test_token_fixture.py
```

Every added guard includes named semantic negatives with a passing baseline: fixture/model constraints, ownership/image identity, disk bounds, phase completion, source/admission bindings, no-default cursor key, provider options, token expiry, finite control framing/ordering/EOF/deadlines and cleanup despite failure. Crashes/setup failures do not count as the intended negative result. Original endpoint DB evidence is retained without repeated heavy execution.

After exact runtime admission only:

```sh
python dev/accept_membership_directory_image.py --admission /absolute/owned/runtime-admission.json
```

The admission declares exact source/evidence inputs; optional bridge lending additionally requires the separate Lead bridge admission and reviewed client harness. Retain failed evidence. Independent final source/evidence reviews and normal publication gates follow actual qualification; a synthetic assertion test or source allowlist cannot be presented as image execution.

## Changelog

- Specify a single owned image/provider qualification and bounded client lending.

## Terminal pipe completion

A valid bounded terminal child report is not sufficient for success until the child exits0 and streams reach EOF. After validating that report, the parent closes its reply writer to release a child with an outstanding asynchronous pipe read, allows at most5 seconds for shutdown, and refuses any later command or report bytes. Malformed reports never trigger a successful completion. Closed progress evidence records only completed-command count, fixed last operation, terminal-report acceptance and numeric exit status; arbitrary child diagnostics, replies and tokens are never retained. A credential-free subprocess regression must prove the reply EOF arrives before child exit, and must refuse nonzero exit and post-report commands.
