# Contracts

**Status:** Proposed · **Owner:** API seat

The written interfaces of Kodera. They exist before the code that implements them, and they
are the only place where the shape of a request is decided. A feature starts here, not in a view.

| File | What it is | Who speaks it |
|---|---|---|
| [`core-api.openapi.yaml`](core-api.openapi.yaml) | Core API, `/api/v1`, the control plane | `kodera-console`, Kodera staff |
| [`agent-api.openapi.yaml`](agent-api.openapi.yaml) | Agent API, `/agent/v1`, contract 2 of the strategy | the agent on every tenant VM |
| [`examples/`](examples/) | Hand-written request and response bodies used in tests and in the console mocks | both |
| [`CONSOLE_RECONCILIATION.md`](CONSOLE_RECONCILIATION.md) | Endpoint-by-endpoint mapping between the console's screen-flow specifications and this contract, the decisions taken, and the questions still open | both |
| [`served-operations.json`](served-operations.json) | The operations of `core-api.openapi.yaml` a view of the deployed API declares, generated from its urlconf | `kodera-console`, read before it calls an operation |

A third contract, the tenant profile extension `x-kodera.schema.json`, is **not** in this
directory. It lives in `deployment operations/schemas/x-kodera.schema.json` and is **referenced, never
copied**: `deployment profiles` is the reference consumer of the tenant profile format and owns the
schema, and both repositories resolve it by URL plus commit SHA rather than vendoring a second
copy that will drift. Anything in this repository that needs it points at
`https://raw.githubusercontent.com/deployment profiles/<sha>/schemas/x-kodera.schema.json`,
pinned by SHA in the code that reads it. If you find a copy of that file here, delete it.

`docs/INDEX.md` reserved a row for `../contracts/x-kodera.schema.json` and no longer does. The
index fails CI on a row whose path does not exist, so a reserved row for a file this repository is
never going to hold is a row that can only ever be red.

## Ownership

- **Both files**: listed in CODEOWNERS on `contracts/`, which routes review requests and gates no
  merge. No review is required to merge a change to either file: it merges on green CI, and the
  `contract-change` job holds it to the version policy below.
- Neither file is generated. They are hand authored, and the code is checked against them, not the
  other way round.
- `served-operations.json` is the exception, and the reverse: it is generated from the code, never
  edited, and it is not a contract. See "What Core serves" under "Working on these files".

## Versioning

- `info.version` is semver, and it is the version of the **contract**, not of the service.
  - **Patch**: prose, examples, a description. No client is affected.
  - **Minor**: additive and backward compatible. A new endpoint, a new optional field, a new
    optional parameter, a new enum member in a *response* that clients already treat as open.
  - **Major**: anything a client can break on. A removed or renamed field, a new required field or
    parameter, a narrowed type, a removed enum member, a changed status code, a changed default.
- A released contract version is tagged `contracts/vX.Y.Z` on `main`. Tags are created by hand:
  no CI job creates, publishes or checks them, and consumer adoption of a tag is pending
  integration. This document does not forbid the current source pins.
- The URL path version (`/api/v1`, `/agent/v1`) moves only on a major that cannot be avoided.
  A major bump of `info.version` without a path bump is allowed only during pre-launch, while
  `0.y.z` says the contract is not yet frozen.
- Enum members are added in a minor only where the contract says the enum is open for that
  direction. The closed enums — `TenantStatus`, `DomainState`, `DomainFailureCode`,
  `FederationProviderState`, `FederationFailureCode`, `ProvisioningStepLabel`, `EntitlementCode`,
  `MemberImportRowStatus`, `DunningState`, `ConsoleArea`, `CommandKind`, `CommandErrorCode`,
  `OrganisationState`, `BootstrapStepState`, `OwnerClaimState`, `ProblemType`, `WorkspaceState`,
  `WorkspaceSetupState`, `WorkspaceSetupReason`, `ChannelRoomState` — are closed in both
  directions: adding a member is a major. A closed enum exists
  because the console maps every member to one message-catalogue key; a member the console has
  never seen renders nothing, which is why growing one is not additive.
- **While `info.version` is `0.y.z` the contract is not frozen, and a breaking change bumps `y`,
  not the leading zero.** Semver gives `0.x` no compatible-change guarantee, so the rule of the
  bullet above still decides what counts as breaking; only the digit that moves changes. The
  `contract:breaking` label and the breaking-change gate apply exactly as they do after `1.0.0`.
  The first frozen release is `1.0.0`, and from there a breaking change bumps the major and, when
  a client cannot follow it, the URL path version.

## Target contract pipeline

**What runs today.** The `contract-change` job in
`../../../.github/workflows/ci-server.yml` runs Redocly lint and the compatibility/version
policy gate. The reusable server workflow feeds the required `ci-ok` aggregate through
`../../../.github/workflows/ci.yml`. The linter installs from
`contracts/lint/package-lock.json` with `npm ci --ignore-scripts --engine-strict` and uses
`contracts/lint/redocly.yaml`: `recommended`, missing 4xx responses raised to errors, and
an operation-level rule requiring `'400'` when `parameters` or `requestBody` is declared.
Path-item-only parameters remain outside that rule because malformed path parameters
use `404 not-found` under `docs/api/CONVENTIONS.md` §6.

Before linting the real documents, `scripts/ci/prove-contract-lint-fails.selftest.sh`
checks the refusal harness and `scripts/ci/prove-contract-lint-fails.sh` proves rejection
of dangling references, missing query/body `'400'` responses, and missing all 4xx responses.
Version-policy self-tests and mutations, compatibility-gate self-tests and mutations,
and event-planning self-tests run before the actual comparison.

The root `scripts/ci/ci-plan.py` selects this workflow for changes under
`apps/server/` or `packages/api-contract/`, and for relevant workflow/tooling changes.
The orchestrator runs for pull-request updates (including label additions/removals)
and pushes to `main`. Pull requests compare against the target merge-base; pushes
compare against the previous commit. Every `apps/server/contracts/*.openapi.yaml`
is covered under [`CONTRACT_VERSION_POLICY.md`](../docs/specs/CONTRACT_VERSION_POLICY.md).
The workflow does not provide tag or manual-run triggers.

Spectral, the generated-versus-committed diff, Schemathesis and client generation are not wired; a
pull request that wires one moves it into this section. Gates 2, 4 and 5 below, and the Spectral
half of gate 1, are what the contract is owed, not what it gets.

The five gates:

1. **Lint**. `redocly lint contracts/*.openapi.yaml` with the repository ruleset
   (`contracts/lint/redocly.yaml`), plus `spectral lint` as a second opinion. Errors fail;
   warnings are printed and do not fail. The `redocly` half runs today; Spectral does not.
2. **Generated versus committed** (not wired). Owed: a spec generated from the code with
   `drf-spectacular` and diffed against `core-api.openapi.yaml`, divergence failing the build.
   The committed file is the source of truth: when the diff is red, the code is wrong, not the
   contract. This is the gate that keeps "spec-first" true after the first sprint.
3. **Breaking-change gate** (runs, in the `contract-change` job). `oasdiff changelog` between the
   contract at the base and at the head. The base is the merge-base with the target branch for a
   pull request, the commit before the push for a push to `main`, and the merge-base with `main`
   for any other run. `contracts/oasdiff-severity-levels.txt`, read as it is at the base, raises
   to an error each oasdiff check listed in `CONTRACT_VERSION_POLICY.md` §Severity overrides, so a
   change to that file takes effect after it merges. The gate itself counts as an error any
   change to `servers`, any change to a security scheme other than its description, a removed
   security scheme (an added one is additive), and any entry added to or removed from an
   operation's `x-kodera-authz` or `x-kodera-scope`, with operations matched whatever their
   path parameters are named. Roles and scope entries are compared as sets: reordering or
   repeating an entry is not a change to them, so a pure reorder is a patch. A finding
   at ERR or WARN classifies the change breaking, a finding at INFO additive, a changed document
   with no finding a patch, and a document that parses equal unchanged.
   `contracts/check-version-policy.sh` then fails a breaking change unless the pull request carries
   the `contract:breaking` label **and** increments `info.version` under the rule above: a minor
   increase or promotion from `0.y.z`, a major increase once frozen. It fails an additive change
   without at least a minor increase, and any other change to the document without a greater
   version. A deleted contract fails; an added one passes once it parses. CI checks that the label
   is on the pull request, not who put it there. Not covered, with how each classifies today:
   renaming a contract file (a deletion, refused); renaming a component schema with its references
   (additive); a change to any other `x-kodera-*` extension (patch); a global `security`
   requirement added (additive).
4. **Schemathesis** (not wired). Owed: `schemathesis run` against a live test API on
   `staging`, with a staff token and a tenant token, checking status codes, response schemas,
   `Content-Type`, and that every error is a well-formed problem document, with stateful test
   cases for the order flow and the domain state machine, on `main` nightly as well, because a
   green spec against a stale server proves nothing.
5. **Client and mock generation** (not wired). Owed: on merge to `main`, publish the spec as a
   build artefact and generate, from `core-api.openapi.yaml`:
   - a **TypeScript client** (types plus a fetch wrapper) published to the private registry as
     `@kodera/api-contract`, versioned with the contract tag (contract tags are created by
     hand);
   - **MSW handlers** with a default happy-path response per operation, taken from the `examples`
     in the schemas.

   The target console integration consumes both. In that target, hand-written mock code is
   limited to **scenario overlays**: provisioning in progress, domain verification failing, invoice overdue, capacity at
   92 percent. Anything else hand-written in the console's mocks is a bug in this contract's
   examples.

   The proposed console CI refuses a pinned contract version more than one minor behind the
   latest `contracts/vX.Y.Z` tag; this check is not established by this document.

Two rules that are not CI but are enforced in review:

- **No prose in `type`**. Clients switch on the problem `type` URI and on `code`, never on `title`
  or `detail`. A pull request that makes a client parse prose is rejected.
- **No customer personal data in an example.** Examples are fixtures; they end up in test output,
  in Storybook and in generated docs.

## Conformance tests for `greffer` on `lab`

ADR-0001 says `greffer` replaces Ansible plus cron as the agent when it passes the contract tests
on `lab`. `lab` is a tenant, not a staging environment: the tests run against a real tenant with
no customers on it.

The following is a proposed acceptance suite. It has not been executed by this
offline helper or by the local health runtime. Its intended integration is core
CI against `lab`, with the same suite for both candidate agents. Infrastructure
creation and execution require their separate existing authorization and review.

**A. Heartbeat**

1. A heartbeat every 60 s for 10 minutes: core records 10 heartbeats, `seq` strictly increasing,
   no gap, `stale` never set.
2. Stop the agent for 190 s: core marks the tenant `stale` after the third missed heartbeat and
   not before the second.
3. Restart the agent: `boot_id` changed, `seq` restarted at 0, `stale` cleared on the first
   heartbeat, and core did not treat the reset as a regression.
4. Replay a heartbeat with a `seq` already seen: accepted and discarded, no state change.
5. Every required member of `Heartbeat` is present and typed; `services` names every compose
   service in the rendered profile, no more and no less.
6. `vitals.cert_days_left` has one entry per host in `x-kodera.hosts`.

**B. Command lifecycle**

7. Dispatch `preflight{phase: config}`: the agent acks within 5 s, reports at least one `running`,
   then exactly one terminal result with `artefacts.check_count` and `artefacts.fail_count`.
8. Dispatch the same `command_id` twice: executed once, second delivery answered from the local
   ledger with the identical result.
9. Kill the agent between `ack` and `result`: the command reappears after `visibility_timeout_s`
   and the agent replays instead of re-executing.
10. Report a terminal result twice with the same status: second call answers `recorded: false`.
11. Report a second terminal result with a different status: refused with
    `command-already-terminal`.
12. Report `failed` without `error_code`: refused with `error-code-required`.
13. Every `error_code` the agent can emit is a member of `CommandErrorCode`. The suite asserts this
    by fault injection, one induced failure per code the implementation claims to support.

**C. The eleven kinds**

14. `start`, `stop`: the stack goes down and comes back, volumes intact, `services` in the next
    heartbeat matches.
15. `maintenance{on}` then `{off}`: the edge serves 503 with `Retry-After` while held, y-provider
    is drained before the 503 starts, `maintenance` is true in the heartbeat, and the console
    banner follows.
16. `render{profile_version, config_ref}`: secrets arrive only through the config bundle, files are
    written mode 600 owned by the service user, and the resulting `compose_digest` matches what
    core expected. A `render` whose payload contains a secret-looking value fails the review, and
    the self-test asserts no secret is present in any dispatched command body.
17. `upgrade{to_version, safety_snapshot: true}`: the ordered sequence is observed —
    maintenance on, hot snapshot, pull, up, migrate, preflight, maintenance off — and
    `artefacts.snapshot_id` is reported.
18. **Red-preflight rollback**: with an injected preflight failure, the agent restores the safety
    snapshot, reports `failed` with `preflight_failed`, and the tenant is serving the previous
    version with no data loss. This is the single most important test in the suite.
19. `backup{hot}` while serving, and `backup{cold}`: both report a `snapshot_id`, and
    `vitals.backup_age_s` drops in the next heartbeat.
20. `restore{snapshot_id, compose_digest}` with a **mismatched** digest: refused with
    `digest_mismatch`, nothing changed on the host.
21. `rotate{secret_name}`: the new value is pulled by `config_ref`, never present in the command,
    the service reloads, and the old value is gone from disk.
22. `self_update{version, signature}` with a **bad** signature: refused with `signature_invalid`,
    the binary on disk is unchanged. With a good signature: the agent replaces itself, `boot_id`
    changes, `seq` resets, and the loop resumes within one interval.
23. `decommission`: the stack stops, local secrets are wiped, the credential is revoked, and
    heartbeats stop. A heartbeat after decommission is refused with `instance-decommissioned`.

**D. Security**

24. mTLS with a certificate for another instance: `403 instance-mismatch` on every endpoint.
25. A body claiming a different `tenant` or `instance_id` than the credential: refused, and the
    credential wins in every case.
26. `GET /agent/v1/config/{config_ref}` after the command reached a terminal result:
    `410 config-ref-expired`.
27. A `config_ref` belonging to another instance: `404`, indistinguishable from an unknown one.
28. No secret from a config bundle appears in any `log_ref` output, in `error_detail`, or in
    `journald`. Asserted by grepping the uploaded logs for the known fixture values.
29. Every check above ships with a **self-test mutation** that proves the check can fail, per
    `AGENTS.md`. A conformance suite that cannot go red is not a gate.

**Exit criterion.** `greffer` replaces Ansible plus cron when A to D are green on `lab` on three
consecutive nightly runs, and when it also has direct ingress with per-host TLS, envelope-encrypted
secrets and CA key, and green CI in its own repository (ADR-0001).

## Working on these files

- The version policy and the breaking-change gate are specified in
  [`CONTRACT_VERSION_POLICY.md`](../docs/specs/CONTRACT_VERSION_POLICY.md), and CI runs both in
  the `contract-change` job. To run them locally, put the oasdiff release binary for the version
  `../../../.github/workflows/ci-server.yml` pins (`OASDIFF_VERSION`) on `PATH`; the gate refuses any other
  version, a build from source included:

  ```sh
  make contract-version-selftest
  uv run bash contracts/check-version-policy.mutations.sh
  make contract-change-selftest
  bash contracts/check-contract-change.sh --head HEAD --target origin/main
  ```

  The last line is what CI runs on a pull request; add each of the pull request's labels as
  `--label=NAME`. The policy script alone classifies nothing: `check-version-policy.sh --change
  KIND` trusts the KIND it is given and does not read labels from GitHub.

- Validate locally before pushing:

  ```
  (cd contracts/lint && npm ci --ignore-scripts)
  ./contracts/lint/node_modules/.bin/redocly lint --config contracts/lint/redocly.yaml contracts/*.openapi.yaml
  .github/scripts/prove-contract-lint-fails.sh
  npx -y @stoplight/spectral-cli lint contracts/*.yaml
  ```

  The first three are what CI runs; Spectral is the second opinion CI does not run yet.

  With no network, at minimum:

  ```
  python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" contracts/*.yaml
  ```

- Every operation carries **both** `x-kodera-scope`, the `<resource>:<verb>` of the matrix in
  `docs/api/AUTHZ.md` §5, and `x-kodera-authz`, naming the roles allowed. An operation missing
  either is incomplete, and the authorisation-matrix steps of the `lint` CI job fail on it rather than letting it default
  open. On the view side, `tests/architecture/test_view_scopes.py` fails on a routed view whose
  declared scope is missing or differs from its operation's; the import-time raise and the
  deny-by-default permission layer of `docs/api/AUTHZ.md` §5 are specified and not built. The
  authorisation tests read both extensions to build their matrix.
- Every `PATCH` takes `If-Match` and answers `412` and `428`; every read of a patchable resource
  returns an `ETag`.
- Every `POST` but `previewInvitation`, a read, takes `Idempotency-Key`. Every response declares `X-Request-Id`.
- **What Core serves.** The contract says what Core may serve; `served-operations.json` says which
  of its operations a routed view declares today. It lists, sorted, the `operation_id`, `method` and
  contract `path` of every operation a view declares under `api/v1/` in the urlconf
  `config/settings/deploy.py` names. Both directions rest on one convention: a plain function view,
  which almost every Core view is, answers exactly the methods it declares. Only its body knows,
  and `tests/architecture/test_view_scopes.py` names that as not seen. Under that convention an
  operation in the contract and not in the file is not served (Core answers `404`, or `405` on a
  path routed for other methods), and a listed one is. For a class view the scope test checks that
  an unlisted method is not served; a declared method a class has no handler for is still listed.
  `tests/test_served_operations.py` fails when the checked-in file differs from what the routes
  declare, and names each operation served but not listed or listed but not served; regenerate with
  `uv run python dev/served_operations.py`. A consumer vendors the file from the same Core ref as
  the contract and fails its own build on a call to an operation the file does not list.
- Every schema carries `required`, and every schema carries at least one example. The examples are
  not decoration: they become the MSW mocks.

## Changelog

- First version. Ownership, semver plus `contracts/vX.Y.Z` tags, the CI gates, where
  `x-kodera.schema.json` lives, and the conformance outline for the agent implementation.
- Adds the `Status` / `Owner` header every document in this repository carries (`docs/INDEX.md`),
  records that the index no longer reserves a row for the fleet-owned profile schema, and states
  the two endpoint extensions and the `If-Match` rule the contract now declares.
- Commits the repository ruleset (`contracts/lint/redocly.yaml`) and the linter's lockfile, adds
  the `'400'` every operation with input owed, puts the stripped-400 mutation into the probe CI
  runs, and restates the five gates in the owed tense: only the `redocly` half of gate 1 runs.
- `core-api.openapi.yaml` 0.6.0 → 0.7.0, breaking under the rules above: `ProblemType` is closed
  and gains five `owner-claim-*` members; `OrganisationCreateRequest` gains two required fields,
  `instruction_ref` and `intended_owner`, and `createOrganisation`'s `201` body becomes
  `OrganisationIntakeResult`. Two operations are added, `getOrganisationBootstrap` and
  `consumeOwnerClaim`, with the `bootstrap` principal in `x-kodera-authz`. `OrganisationState`
  is extracted from the inline enum on `Organisation.state` and joins the closed list with the
  two new bootstrap enums; `Membership.source` gains `owner_claim`. The closed-enum rule is why
  the bump is breaking even though every operation the console calls today keeps its shape.
- Wires gate 3: the `contract-change` job classifies every contract change with a checksum-pinned
  `oasdiff`, raised by `contracts/oasdiff-severity-levels.txt` to this document's Major list, and
  holds it to the version policy on every pull request and every push to `main`. Deletes the
  claims that a second reviewer applies to the `contract:breaking` label and that the API is built
  with `drf-spectacular`, and marks gates 2, 4 and 5 not wired.
- Gate 3 reads the severity file as it is at the base commit, counts a change to `servers`,
  `x-kodera-authz` or `x-kodera-scope` as breaking, raises three more oasdiff checks, compares
  a push to `main` with the commit before the push and any other run with its merge-base with
  `main`, and refuses an oasdiff that is not the pinned version. Tags are created by hand; the
  sentences saying no tag exists for the current contract version are deleted.
- Roles and scope entries are compared as sets, so reordering them is a patch, not a breaking
  change.
- Gate 3 also refuses a changed or removed security scheme and a required field removed in two
  steps, matches operations whatever their path parameters are named, reads no labels for a push
  that changes no contract, and says so when a manual run has nothing to compare.
- `core-api.openapi.yaml` 0.9.1 → 0.10.0, breaking: one organisation slug pattern, 2–20 characters,
  on all five schemas that carry it (`OrganisationBootstrap` narrows from 3–64); the tenant slug
  becomes a 3–32 DNS label on `OrderRequest.tenant`, `Tenant` and `checkSlugAvailability`, and
  the tenant slugs `SlugAvailability` and `SupportTicket.tenant_context` return carry the same
  pattern in place of a 64-character cap (the organisation minimum of two is the lead's own
  call, register SLUG-MIN, which 0.11.0 supersedes with the owner's answer);
  `placeOrder` drops `staff_operator`, because the order carries the customer's DPA acceptance.
  Prose that put the realm on the tenant slug, and the owner-claim replay wording, follow B1 and
  `CONVENTIONS.md` §8.
- `agent-api.openapi.yaml` 0.2.1 → 0.3.0, breaking: `Heartbeat.tenant` narrows from 3–64 to the
  3–32 tenant DNS label of `core-api.openapi.yaml` 0.10.0, and `ConfigBundle.tenant` carries the
  same pattern in place of a 64-character cap.
- `core-api.openapi.yaml` 0.10.0 → 0.11.0, breaking: the organisation slug narrows from 2–20 to 5–20
  characters on all five schemas that carry it (`Organisation`, `OrganisationCreateRequest`,
  `OrganisationSummary`, `RealmDiscoveryRequest`, `OrganisationBootstrap`), the owner's answer on
  the minimum (register SLUG-MIN-ANSWER), superseding the lead's own call of two (register
  SLUG-MIN). The character rules and the maximum are unchanged, and so is the tenant slug of 3–32.
  The examples name the organisation `acme-sa`, and its realm with it; the tenant slug `acme`
  stays. `agent-api.openapi.yaml` carries no organisation slug and
  stays at 0.3.0.
- Ownership no longer asks a console reviewer for a `core-api.openapi.yaml` change or a fleet
  owner's review for an `agent-api.openapi.yaml` change, and no longer names `kodera-hq/core`
  as the owner: CODEOWNERS on `contracts/` routes review requests and gates no merge, and a contract
  change merges on green CI under the `contract-change` job.
- The rule on the two extensions no longer says a view without a declared scope raises at import
  time, which nothing does: it names the `authz-matrix` job and the view-scope architecture test,
  and says the import-time raise and the permission layer are not built.
- `core-api.openapi.yaml` 0.11.1 → 0.12.0, breaking: `discoverRealm` is reshaped to the approved
  realm-discovery policy R1–R5/R6-A (`docs/specs/REALM_DISCOVERY.md`). Its `Idempotency-Key` becomes
  the dedicated `DiscoveryCompatibilityKey`, validated and discarded, never a replay identity; the
  result is a current zero, single or multiple set of at most 20 eligible organisations; every
  response is `no-store` and correlated; `413`, `415`, `422` and a route-local `503` are declared
  beside `400` and `429`. Every other `POST` keeps the generic replay rule.
- `core-api.openapi.yaml` 0.12.0 → 0.13.0, breaking: the `IdempotencyKey` parameter gains the
  `pattern` the replay store enforces, 16–255 visible ASCII characters, and says a key outside it is
  `400 malformed-request`, so a key with a space or a non-ASCII character, accepted on the wire
  before, is refused. Additive besides: `getWorkspace` and `initialiseWorkspace` under a new
  `Workspace` tag, with the `workspace:read` and `workspace:act` scopes and the schemas `Workspace`,
  `WorkspaceInitialisation`, `WorkspaceState`, `WorkspaceSetup`, `WorkspaceSetupState`, `WorkspaceSetupReason`,
  `WorkspaceCategory`, `WorkspaceChannel` and `WorkspaceTemplateKey`
  (`docs/specs/PILOT_WORKSPACE_ONBOARDING.md`). `getWorkspace` is a conditional `GET` whose `ETag`
  hashes the caller's rendered view; `initialiseWorkspace` answers `Location` and its state only,
  never the structure. Also the `Idempotency-Replayed` header, declared on
  every response a keyed `POST` can replay; `Problem.first_seen_at` for `idempotency-key-reuse`;
  and the `IdempotencyKey` description no longer counts the operations that take it and says when a
  retry reuses the key. The three new enums join the closed list above. `getWorkspace` takes
  `If-None-Match` and declares a `'400'`, so the count of operations outside the stripped-400 lint
  rule stays 27.
- `core-api.openapi.yaml` 0.13.0 → 0.14.0, breaking: aligns `createOrganisation` with its
  implementation (`docs/specs/ORGANISATION_INTAKE.md`). `ProblemType`, a closed enum, gains
  `slug-taken` (409, a slug already held) and `intake-closed` (503, a database that does not admit
  the intake yet, `docs/specs/FIRST_OWNER_BOOTSTRAP.md` §3.8), and the operation declares the `503`
  and describes its `409`. `OrganisationCreateRequest.slug` refuses the closed reserved list
  `master`, `kodera-staff`, `kodera-probe`, `kodera-dev`, `kodera`, `staff`, `admin` — the identity
  provider's administration, staff, studio and lab realms and three platform names — which the
  database refuses too (`organisation_slug_not_reserved`, migration `orgs.0008`). `instruction_ref` gains the pattern `^[A-Z]{2,8}-[0-9]{1,8}$`, a ticket
  reference such as `SUP-0418`, so no contact can be pasted there in clear. `name` gains `minLength: 1` on `OrganisationSummary` and on the create and
  patch requests and on `Organisation`, which the database already required, with its existing
  `maxLength: 200`. `Problem` declares `reason` (for `conflict`, with no value defined yet) and `required_amr` (for
  `mfa-required`). The prose says the intended owner's contact and the optional profile members
  are sealed on the intake record, with no `Contact` row and no `Organisation` column for them.
- `core-api.openapi.yaml` 0.14.0 → 0.14.1, prose: the reserved-slug description states that the
  database refuses the reserved names, now that `orgs.0008` (`organisation_slug_not_reserved`)
  lands with the intake's implementation, rather than that it will once that migration lands.
- `agent-api.openapi.yaml` 0.3.0 → 0.4.0, breaking under the rules above: the closed `CommandKind`
  gains `engine_set_member_subjects` (core ADR-0016). `CommandPayload` gains `revision`,
  `active_subjects`, `inactive_subjects` and `released_subjects` (schema `MemberSubjects`), and
  `CommandResult.artefacts` gains `revision_applied`, `users_deactivated`, `users_reactivated`,
  `documents_kicked` and `participants_removed`. Core serves the command loop for this kind only.
- `core-api.openapi.yaml` 0.21.0 → 0.22.0, breaking (`contract:breaking`): the Espace structure
  administration of `docs/specs/ESPACE_STRUCTURE.md`. Ten operations for `org_owner` and
  `org_admin` — `createCategory`, `patchCategory`, `deleteCategory`, `createChannel`,
  `patchChannel`, `archiveChannel`, `unarchiveChannel`, `getChannelAccess`, `patchChannelAccess`
  and `getWorkspaceAdministration` — with a strong `ETag` per category, channel and access,
  `If-Match` required on each `PATCH` and enforced when a `DELETE` carries it, and the shared
  `WorkspaceBusy` `503`. `Problem.reason` lists its first value, `category_not_empty`.
  `ChannelRoomState` joins the closed list above. `OrganisationCreateRequest.slug`'s closed reserved
  list gains the platform labels `notify`, `staging`, `status`, `support`, `billing`, `console`,
  `developers`, `matrix`, `auth-admin` and `auth-mail`, which the database refuses from
  `orgs.0013`.
- `core-api.openapi.yaml` 0.22.0, the same breaking minor: `WorkspaceChannel` requires
  `room_state`, so `getWorkspace` says whether each channel's room exists; `initialiseWorkspace`
  creates template version 2, with the audio room `lounge` in `team`; and the closed `AppCode`
  replaces `tchap` with `messaging` (ADR-0018), which `apps/billing/catalogue` follows.
- `core-api.openapi.yaml` 0.22.0, review round: the ten structure operations declare `429`, as
  `getWorkspace` does, and the two reads a `503` for a stored row they cannot read; the operations
  that name a row are `404` before the workspace exists, leaving `409 invalid-state-transition`
  to the two creates; `ChannelRoomState` says the room exists, not that its access is applied.
- `agent-api.openapi.yaml` 0.4.0 → 0.5.0, breaking under the rules above: the closed `CommandKind`
  gains `engine_set_channel_members` (core ADR-0018). `CommandPayload` gains `all_members` (the
  organisation's Espace members, once) and `channels` (schema `ChannelMembership`: each Espace
  channel's kind, name, topic, access ETag, audience with its members or denied, flags,
  exemptions and pending notices), and `CommandResult.artefacts` gains `channels_applied`,
  `failed_channel_ids` and `notices_posted`. The loop states that Core answers at once with
  `poll_after_s` 3 and never holds a connection while waiting. The member set gains `erased_subjects`, the
  inactive subjects of erased people whose messaging account the agent erases, and the artefact
  `users_erased`.
- `core-api.openapi.yaml` 0.22.0 → 0.23.0: `createChannel` refuses a workspace's 501st channel that
  is not deleted with `409 conflict`, `reason: channel_limit`, which `Problem.reason` lists; the
  most one channel set can carry (agent-api 0.5.0, `docs/specs/ESPACE_STRUCTURE.md` §13.2); and a
  structural change whose channel set the emitter refuses is `409 conflict`, `reason:
  channel_set_too_large`, which `patchChannel` and `patchChannelAccess` now declare.
- `core-api.openapi.yaml` 0.23.0 → 0.24.0: `cancelOrder` credits an issued unpaid invoice with a
  credit note of its own series (`AV-`) so an unpaid order can be cancelled and no issued invoice is
  ever voided; adds `listCreditNotes` and `getCreditNote`, the `CreditNote` and `CreditNoteLine`
  schemas, and `Invoice.credit_note_id`; narrows `invoice-issued` to an invoice held by a payment.
- `core-api.openapi.yaml` 0.24.0 → 0.24.1: `WorkspaceAdminCategory` and `WorkspaceAdminChannel`
  carry `examples` matching `WorkspaceAdministration.examples[0]`, so every 2xx `application/json`
  response schema carries an example.
- `core-api.openapi.yaml` 0.24.1 → 0.25.0, additive: `createOrganisation` returns its stable,
  deterministic `realm_create` job key as `X-Operation-Ref` on the committed `201`, every replay
  of that success and `409 idempotency-key-in-flight`. The shared `409` declaration is conditional
  and excludes `slug-taken` and `idempotency-key-reuse`; no lookup or authority is attached to the
  value. The same release corrects `Identity.mfa_enrolled` to the exact current identity's signed
  local-TOTP registration fact and clarifies that `required_amr` applies to every staff write and
  `consumeOwnerClaim`.
- `core-api.openapi.yaml` 0.25.0 → 0.25.1, patch-compatible metadata and prose:
  `TenantStatus.decommissioning` reserves the
  bounded recovery window and future independent shared-lock export lane, while explicitly stating
  that no current API operation admits that export. The future cutoff runs active-store destruction
  and then a durable evidence finalizer; `TenantStatus.deleted` means active stores are destroyed and
  the initial deletion attestation exists. Immutable backups follow their separate expiry and purge
  clock, and the final certificate follows that purge. The Components extensions carry the normative
  future-writer audit-action registry and the compatible wire-to-canonical actor mapping; they do not
  narrow the public `AuditEvent` wire shape. No public schema, enum member or operation changes.
- `core-api.openapi.yaml` 0.25.1 → 0.25.2, patch, prose only: `info.description` gains the normative section "Espace:
  from the channel tree to Matrix rooms". It maps the organisation slug to the homeserver
  `server_name`, a member's `sub` to their Matrix user, a channel `id` to the alias
  `#kodera-ch-{id}:{server_name}`, the `io.kodera.room.policy` and `io.kodera.room.occupancy` state
  events, and the membership and removal rules every client (the console and the native apps) follows.
  No path, schema, parameter or response changes.
- `core-api.openapi.yaml` 0.25.2 → 0.26.0, minor: `discoverRealm` declares `403` `forbidden`, a
  browser request whose `Origin` is not an exact allowed Console origin or whose `Sec-Fetch-Site`
  is `cross-site`. That refusal, a wrong media type (`415`) and a missing or invalid compatibility
  key (`400`) are now decided from the headers alone, before any quota charge or body read, so they
  carry no `RateLimit-*` counters. The slug and email-domain quotas are per client IP, one IPv6 /64
  counts as one client, and the issuer is the configured identity provider's realm issuer rather
  than a fixed host. An email lookup answers the zero result while no verified domain association
  exists. No other path, schema or parameter changes.
- `core-api.openapi.yaml` 0.26.0 → 0.27.0, minor: `x-audit-action-registry` gains
  `outbox_delivery.drift_detected`, the realm access bulk verification's record that a person Core
  turned off was enabled in their realm and a correcting `access_off` was enqueued
  (`docs/specs/MEMBERSHIP_LIFECYCLE.md` §6.1.9). No path, schema, parameter or response changes.
- `core-api.openapi.yaml` 0.27.0 → 0.28.0, breaking under the rules above: `ProblemType`, a closed
  enum, gains `identity-unknown`, and a case changes status. `identity-unknown` is a `403`
  without `WWW-Authenticate` for a bearer token that verifies but whose `(iss, sub)` names no
  enabled, undeleted customer identity of an enabled, undeleted person (`docs/api/AUTHZ.md` §2,
  step 6). Every customer operation that answered that case `401` now answers it
  `403 identity-unknown`: a client routes the person to "no organisation yet" instead of looping
  through sign-in. `401 unauthenticated` is unchanged for every verification failure, an unknown
  realm or issuer included, and the staff lane is unchanged. The `Forbidden` and `Unauthenticated`
  responses say so, naming the `invited` principal on `acceptInvitation` as the one exception and a
  staff token as never `identity-unknown`; `consumeOwnerClaim`'s `403` names the type, and `patchMe`
  and `checkSlugAvailability` declare `403`. No path, schema or parameter changes.
- Adds `served-operations.json`, the operations a view of the deployed API declares, generated from
  its urlconf and held current by `tests/test_served_operations.py`, so a consumer can fail its
  build on a call to an operation Core does not serve. No contract changes.
- `core-api.openapi.yaml` 0.37.1 → 0.37.2, patch, prose only: the normative Espace table in
  `info.description` maps the **tenant's** `slug` (`Tenant.slug`) to the homeserver's `server_name`,
  not the organisation's, as `TenantCreation.slug` already says and the console derives it
  (ADR-0023, which partly supersedes ADR-0018). No path, schema, parameter or response changes, but the rule a client follows
  does: one that derived the server name from the organisation's slug reads the tenant's. The
  console has followed it since kodera-console #333.
- `core-api.openapi.yaml` 0.37.2 → 0.38.0, breaking minor: the reserved tenant slugs, now a closed list
  stated on `SlugAvailability.reason`, gain the platform labels of `kodera.io` that organisation
  slugs already reserve: `notify`, `staging`, `support`, `billing`, `console`, `developers`,
  `matrix`, `auth-admin` and `auth-mail`, and the platform hosts `errors` and `ops-admin`, which
  organisation slugs do not reserve yet. A tenant's slug names its Matrix homeserver (ADR-0023),
  so `staging` would have been the staging Matrix domain itself. `placeOrder`, `createTenant` and
  `checkSlugAvailability` refuse them (`422` at the slug, or `reserved`), and so does the database
  (migrations `tenancy.0003` and `0004`). No path, schema shape, parameter or response changes;
  a request that names one of them was accepted and is now refused.
- `core-api.openapi.yaml` 0.38.0 → 0.39.0, breaking minor: the reserved organisation slugs, the
  closed list under `OrganisationCreateRequest.slug`'s `not`, gain `errors` and `ops-admin`, two
  platform-prod hosts of `kodera.io` (deployment profiles `policy/kad-platform-ingress.yaml`) that the
  0.22.0 list missed. `createOrganisation` refuses them `422 reserved`, and so does the database
  (migrations `orgs.0018` and `orgs.0019`). A request that names one of them was accepted and is
  now refused. Both lists are now pinned to one list of the labels of `kodera.io` in Core's tests,
  so they cannot drift apart again.
- `core-api.openapi.yaml` 0.41.0 → 0.42.0, breaking minor, three decisions of the product owner.
  **Directory privacy:** `Membership.email` may be `null`, and the schema names five private
  member facts (`email`, `identity_id`, `account_kind`, `mfa_enrolled`, `last_seen_at`) that
  `listMemberships` and `getMembership` disclose on a row only to the person it describes and to
  a caller who holds `org_owner` or `org_admin`. Every other caller receives them omitted or
  `null`, never masked, so a client that read a colleague's `email` as always present must read
  it as optional and nullable. `countMemberships` says its unanswered `account_kind` filter will
  be refused `forbidden` to those other callers. **Proximity:**
  `InstantClaimTenantRequest.templateId` is the new `WorkspaceTemplateId`, which gains `proximity`
  and keeps `crisis-cell` as its deprecated, permanent alias; `#proximité` is a display label and
  never an identifier. `ProximityCheckInHandle` and `ProximityCheckInPseudonym` are reserved for
  the check-in model and no operation carries them. **Themes:** `ThemeId` is exactly `light`,
  `dark`, `black`, `ciel` and `ciel-nuit`; `ThemeIdAlias` keeps `givre`, `ardoise` and
  `real-black` as deprecated aliases of the first three, and
  `InstantClaimTenantRequest.themeId` accepts both lists. No path, parameter or status changes.
  This entry is the contract alone: Core's masking, and its acceptance of `proximity` and of the
  five `ThemeId` values, ship in the server change stacked on it. The self-test of the change gate
  now refuses the removal of either alias and a nullable `email` without its bump or its label,
  and stops when the committed contract no longer carries them.
- Adds `check-contract-parity.sh` and its self-test: every copy of a contract under
  `apps/server/contracts/` and `apps/web/contracts/` is compared with `packages/api-contract/`,
  each drifted or missing file is named, and one changed byte in any copy is refused. The
  workflows still run their own `cmp -s` lines; no contract changes.


## Monorepo execution

Status: Active

The reusable `ci-server.yml` workflow runs OpenAPI lint and its failure proofs, version-policy
self-tests and mutations, contract-change and event-selection self-tests, and their mutation
suite. The `contract-change` job compares `apps/server/contracts/*.openapi.yaml` at the PR
merge-base and head (or before/after a main push), then invokes `check-version-policy.sh` with
the computed classification. The locked Redocly CLI and SHA256-verified oasdiff release are
installed before these checks. Canonical `packages/api-contract/` changes trigger both server
and web areas; byte parity checks bind the server and web copies to that canonical source.
The reusable server workflow is required by the root `ci-ok` aggregate.

With oasdiff 1.37.0, requiring authentication on an anonymous operation is the built-in ERR
`api-security-anonymous-access-removed`. The obsolete `api-security-added` override is removed;
the `security-added` failure proof still requires the breaking-change label refusal.

`response-required-property-became-write-only` is also a built-in ERR in this release.
Its redundant override is removed, while a dedicated real-contract-pair self-test retains
the error and label-refusal assertions. Every remaining override has a deletion mutation.
