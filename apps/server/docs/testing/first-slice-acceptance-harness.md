# First-slice acceptance harness

**Status:** Proposed · **Owner:** API seat

`tests/first_slice/` runs every one of the thirty-three mandatory first-slice scenarios as a
collected pytest test, inside the ordinary `pytest` step of CI, and holds each to one honest state.
None passes today. Thirty-two are expected failures whose specified path is not built, and one is
blocked on a named open decision. Each is red at the first missing thing it reaches, and CI
fails if that point ever moves without the inventory moving with it.

`tests/first_slice/scenarios.toml` is authoritative for scenario state. `make acceptance-first-slice`
and its bootstrap driver, described in [`first-slice-acceptance-inventory.md`](first-slice-acceptance-inventory.md),
remain the evidence and entry-point report; they are superseded for state and say so in their own
output.

## The inventory and the three states

The inventory lists the identifiers, transcribed from the internal `ACCEPTANCE.md` at the commit it
names, with a group, a state, a gap and a reason. CI never reads that prose. It compares the
inventory with two machine-readable sources in this repository instead:

- the collected tests — `test_collected_scenarios_equal_the_inventory_and_the_manifest` collects the
  directory in a child pytest and refuses a scenario that is missing, duplicated, misspelled,
  unmarked or unknown, each by its identifier;
- `dev/first_slice_manifest.json`, the reporter's manifest, in both directions.

| State | Meaning | How it is enforced |
|---|---|---|
| `pass` | The scenario passes against this tree | Runs plainly |
| `xfail` | What it asserts is specified; the path is not built | Strict expected failure accepting only a `ScenarioGapError` whose gap equals the row's |
| `blocked` | What it asserts depends on an open decision | The body checks the decision first; strict expected failure accepting only `BlockedOnDecisionError` on that decision |

A scenario therefore fails CI when it starts passing, when it turns red for a reason its row does
not record, when it skips, and when it is decorated with its own `xfail`. A failure that is not a
gap is summarised by its exception type and message, never by the gap the row hoped for. A
precondition that reaches a decision — MFA before a claim, for instance — moves the observed gap to
that decision, and the row has to be reclassified in the same change.

The tenant-scoped retained-access window is decided: designated closure principals receive bounded
read-only access for at most 90 days, unless a validated controller instruction ends it earlier.
`FS-LIFE-02` is therefore an expected failure at the earlier real-provider second-factor gap. The
only blocked row is `FS-LIFE-03`, on whether legally retained invoices, credit notes and deletion
evidence may be delivered once through independently verified and audited access after application
identity erasure. The delegated Core MFA consumer contract is decided by
`REGISTERED_FACTOR_SIGNAL.md`; FS-BOOT-06 and FS-OP-06
are expected failures at the earlier real-provider second-factor gap.

When the retention runtime lands, `FS-LIFE-02` must continue beyond its current assertions to
freeze trusted time at the exact recovery deadline, make both the delete runner and artefact store
unavailable, and prove a previously ready export cannot be read or unwrapped. Its implementation
change adds a self-test mutation that removes only the runner-independent cutoff and observes the
forbidden read. It also pauses an already-authorized response stream and realtime session after
generation validation but before send, proving termination waits and no old-generation delivery
occurs after commit; holds multiple export/decommission claim sessions, including multiple fences
of one shared-lock job, and live locks through exact expiry, then proves the supervisor creates one
session child per non-reusable tuple and reaps each exact session before that job's cancellation and
reservation release, including a terminal job paused after commit but before unlock beneath its
reap-only job child; transfers each open dispatch to its own job child and all backup/export slots to the parent reconciliation; refuses false no-write under
late acknowledgement or unavailable journal/store and resumes durable finalization after an
arbitrarily long evidence outage; crashes after step 8, after the durable destruction marker and
after live-lock release to prove sweep preservation, supervisor takeover, two-phase close and unique
parent-linked finalization; pauses closure-resource
delivery after authorization before send at exact natural expiry and across an earlier instruction,
with expiry/delete/supervisor unavailable; pauses one pre-fence write through
drain; proves the final backup covers every DB/object/document high-water mark; holds a stale backup
capability through exact natural expiry without the expiry writer/supervisor; races that backup
against an earlier-deletion fence; and proves ordered cancellation with no lifetime bootstrap and
with recorded, verified, expired and replaced histories. It enters `deleted` immediately only with
no lifetime row; its permanent fence serializes and blocks bootstrap record/verify/provisioning.
Every historical-boundary branch remains `ordered` under a complete-scope durable cleanup until
independently verified retirement/absence of every provider boundary lets its unbounded finalizer
attest; cleanup audit actions and order/tenant/organisation/bootstrap scope equality are required,
and provisioning and final-organisation offboarding remain blocked
until then. The identity suite races realm creation against provider snapshot-begin
under the global catalogue reservation and proves the stored realm list exactly matches the dump
bytes. This planning increment records those owed assertions without pretending the absent models,
writers, reservations, export operation or worker can execute them.

Canonical operation scope and
deduplication retention is decided by ADR-0020, so FS-OP-05 reaches the same earlier gap. OD-1 of
[`../specs/FIRST_OWNER_BOOTSTRAP.md`](../specs/FIRST_OWNER_BOOTSTRAP.md),
whether `placeOrder` keeps `staff_operator`, is not a row of that table and is decided: contract
0.10.0 makes `placeOrder` `org_owner` only. The inventory keeps it as a decided row, and FS-BILL-01,
FS-BILL-06 and FS-JOURNEY-01, which it blocked, are expected failures: the offer each needs is
published through the catalogue models, and each then stops at the staff second factor below. FS-ID-03 and
FS-CON-05 assert their decided parts first and reach their decision only afterwards, so they are
expected failures on their first real gap.

`make check-first-slice-expected-red` is the offline G1 planning gate over this exact population;
it reports runtime acceptance as unmet. `make mutate-first-slice-expected-red` proves its count,
decision and blocker guards in disposable copies. Neither command replaces the dynamic harness or
turns a red scenario green.

The slug rules are decided and the contract carries them from 0.11.0: 5–20 characters for
organisation creation and the owner-claim bootstrap alike, since the organisation slug is the realm
name, and a separate DNS-label rule of 3–32 for tenants. The minimum of five is the owner's answer
(register SLUG-MIN-ANSWER). FS-ID-01 and FS-ID-02 still measure every contract slug pattern against
those boundaries first, so a pattern that drifts turns them red on
`contract:organisation-slug-rule-5-20` or `contract:tenant-slug-rule-3-32`; with both carried, they
reach the staff intake, which is routed, and stop at the staff second factor below. The decision names no
reserved slugs, so the reserved-name case is a later, measured contract gap rather than an invented
list.

## Measured and asserted gaps

A gap is measured when the harness looks for the missing thing and raises an `AssertionError`
instead of the gap the moment it appears:

| Gap | Measured against |
|---|---|
| `operation:<operationId>` | The real URL resolver under `ROOT_URLCONF`, with the path read from the contract |
| `record:<model>` | The installed Django models |
| `service:catalogue-publication` | Any non-read contract operation on catalogue, offer or legal-document resources, by path, operation id or tag, and any catalogue model. The catalogue models exist (`apps/billing`): `publish_catalogue` loads the placeholder catalogue and legal documents through the operator's `load_catalogue` and `load_legal_documents` commands, and a contract write on catalogue resources still turns it into a failure until it is driven too |
| `service:owner-claim-revocation`, `service:payment-inbox`, `service:payment-return`, `service:organisation-closure`, `service:operator-reconciliation`, `service:realm-update` | Non-read contract operations matching each. For `service:realm-update`, any operation that could request a `realm_update` job directly — a request body whose `kind`, or a `kind` query parameter of the operation or its path, admits `realm_update` through `enum` or `const`, following `$ref`, `allOf`, `oneOf` and `anyOf` on the body and on `kind` itself; or an operation named for a realm change such as `patchRealmSettings` or `syncRealm` (see Known limits). Today the contract enqueues one only behind federation-provider and membership changes, which need fixtures the harness does not have |
| `worker:runner` | The worker's job runner, `worker.runner`, being a module or package the import system does not find (`dev/worker_boundary.py`, shared with `tests/worker`). The worker process exists (`python -m worker`, G1.5-A, `tests/worker/acceptance.toml`); its runner is G1.5-B |
| `harness:identity-provider-admission` | `KODERA_AUTH_TRUST` admitting no loopback issuer |
| `contract:idempotency-key-in-flight-operation-reference` | The in-flight reply missing a valid `X-Operation-Ref`; response bodies and `Location` are deliberately ignored |
| `contract:organisation-slug-rule-5-20`, `contract:tenant-slug-rule-3-32` | Each contract slug pattern — `OrganisationCreateRequest`, `Organisation`, `OrganisationSummary`, `OrganisationBootstrap`, `RealmDiscoveryRequest`; `Tenant`, `OrderRequest.tenant` — tested at the boundary lengths |
| `contract:reserved-organisation-slugs` | `OrganisationCreateRequest.slug` enumerating no `not: {enum: [...]}` |
| `harness:core-fault-points` | A name a scenario arms that `tests/first_slice/fault_points.toml` records as planned and `core/faults.py` does not declare. A declared name is armed for real; a planned name Core declares, or a name the inventory does not record, is an `AssertionError` |

The rest are asserted, because Core declares nothing to measure them against yet: adapter ports,
implementation weakenings, second-factor evidence and the console. They are
reached only after measured gaps, and are wired in the change that introduces their subject.

`harness:identity-provider-second-factor` is the second-factor gap, and it has two doors. A
customer principal reaches it through `with_second_factor`, after the decision that gates it. A
staff principal reaches it on any request it signs, once the operation is measured as routed:
Core answers every staff token without a second factor `403 mfa-required` (`AUTHZ.md` §3) before
reading the body, and the fixture never mints one. That door is asserted rather than measured on
the response, because the refusal reads the database to audit a stored staff identity, and the
mutation proofs run the scenarios without one. Since `createOrganisation` is routed
(`../specs/ORGANISATION_INTAKE.md`), every scenario that records an intake stops there.

## A run must be a whole population, in an admitted environment

Whenever the population check is selected, or a filter deselects a scenario while others still
run, the session fails unless every mandatory scenario produced a result, and names the scenarios
that were deselected or never ran. `-m`, `-k` and `--deselect` cannot turn CI green.
`FIRST_SLICE_CASE` is the one way to run a single scenario.

Before any scenario runs, the environment is admitted. A configured provider endpoint that is not
local, a public identity issuer in `KODERA_AUTH_TRUST`, or a PostgreSQL that does not accept
connections refuses the run with exit status 4 and a sentence naming the host.

## Real, synthetic, never

Real: `config.settings.test`, the migrations, the URL resolver, middleware and views, driven in
process through Django's test client with paths read from `contracts/core-api.openapi.yaml`; the
production token verifier; a PostgreSQL test database pytest-django creates for the run. Every
harness user declares that database statically, and the harness refuses any database whose name is
not a test database's. Postconditions use `count`, which fails on a missing or renamed model;
`count_if_present` is for fixture preconditions only.

Synthetic: the infrastructure, invoice, payment and mail adapters, each with an effect ledger that
deduplicates nothing, barriers, injected failures before and after the effect — retryable or not,
for the next call or for one correlation — and correlation lookup that can be withdrawn; a clock fixed at `T0` and moved only by explicit offsets; an egress
guard refusing Python-level connections to any non-loopback address.

Never: a mock of Core's own API, or a second factor. The identity fixture signs tokens with a key
generated per process and trusted through `KODERA_AUTH_TRUST`. It is not identity provider
software, so it mints no `amr`, `acr` or `auth_time`, and `with_second_factor` refuses.

## Running it

- Both local commands below run against the disposable, fsync-off `test-db` service, never the
  development database: start it with `make test-db` (see `dev/README.md`, "Test database").
- `make first-slice-scenarios` is first-slice acceptance: it exits nonzero unless every one of the
  thirty-three passes, which today it does not. `CASE=FS-BOOT-01` runs and requires one.
- `DATABASE_URL=postgres://kodera:kodera@127.0.0.1:5434/kodera_server uv run pytest
  tests/first_slice` and CI's `Tests` job keep the inventory semantics: green while every scenario
  is red exactly where its row says.
- The terminal summary prints each identifier with its observed state and gap, decision or actual
  failure, and any session-level refusal.

## Fault points

`core/faults.py` declares eight named points on six `faults.reach()` sites: the intake's
`after-desired-state`, `after-audit` and `after-job` inside its transaction, `before-commit` (crash)
and `hold-before-commit` (hold) as the handler's last statement before the replay entry,
`after-commit` and its alias `after-commit-before-dispatch` once the view's transaction has
committed, and `realm_create:after-provider-success-before-acknowledgement` inside `close_dispatch`.
`h.fault_point(name)` arms one for its body. A crash is an in-process `SimulatedCrash`, a
`BaseException`, so the transaction it leaves rolls back and no `except Exception` in Core swallows
it; the worker's points will be crashed by a real process kill instead. A hold keeps the
transaction open, and `race` releases it once every racer not held there has returned. Leaving the
body, the point must have been reached, a crash must have left Core, and a hold must not have
timed out, or the harness raises an `AssertionError`; the harness also fails a scenario that leaves a point armed. Arming is refused
outside `config.settings.test`, and the deployment profile ships the module inert.

`fault_points.toml` records each site's file, function and the call it must follow, each point's
site and mode, the planned names the worker scenarios arm, and which scenarios arm each.
`make check-first-slice-fault-points` holds the tree to it from source, and
`make mutate-first-slice-fault-points` proves each rule by its own message in a disposable copy: a
timed-out hold counted as served, a deleted `reach()`, an aliased one, the after-commit site moved
before the commit, a crash catchable as `Exception`, the test-profile gate dropped, a point no
scenario arms, a scenario that stops arming its point and a scenario arming an unrecorded name.
The check also refuses `core.faults` bound under another name, `reach` imported or looked up by
name, and a `fault_point` call outside a scenario or with arguments it cannot read. CI runs the
proofs in `tests-complete`, and the check itself in `test`. `tests/test_intake_fault_points.py` drives each point through
the real intake against PostgreSQL.

## Proof that it can fail

`test_first_slice_harness_selftest.py` holds each seam to a positive control and each measured seam
to the change that must turn it into a failure: a routed operation is driven rather than reported
missing; an installed model is counted in PostgreSQL; a decided decision does not block; a
production-verified token carries no second factor; each adapter records, holds, fails and
correlates; nine malformed inventories are refused by name; admission refuses an external endpoint,
a public issuer and a closed database port while admitting local ones; the catalogue tripwire names
a synthetic `publishCatalogue`, a legal-document write, an offer operation, a catalogue tag and a
catalogue model; the realm-update tripwire names a widened job `kind`, an organisation job, a
`kind` composed with `anyOf` and `allOf`, a `kind` query parameter inline and by `$ref` on the path,
a realm-settings patch and a realm sync, and ignores realm discovery, reads, a query `kind` that
admits only other kinds and a path parameter named `kind`; FS-CON-01's source shape is held to the
lead's ruling, because its body cannot run yet — its one failure a direct statement of the
client-creation barrier after the worker reached it, at `before-effect`, for `failed_job`, of the
class the harness exports as `NonRetryableFailureError`, nothing returning or raising before its
outcome assertions, and each outcome assertion present once — which proves the shape, not the
behaviour; and every one of `ACCEPTANCE.md`'s eight minimum
weakenings, and the one that ruling adds, is encoded in the scenario that owns it.

FS-HARNESS-01 runs the actual runner in a disposable copy: a valid environment runs, and a
configured provider endpoint, a public issuer and an unavailable database each refuse before any
scenario reports; the runner's own collection names a removed scenario.

`test_first_slice_harness_mutations.py` copies the repository, applies one weakening, runs a child
pytest, and asserts the exit status, the sentence that names the breakage, the tests that must fail
and the controls that must stay green: the unmutated population; a scenario removed; an identifier
misspelled; a strict expected failure made to pass trivially; a gap the inventory does not record;
a skip; an imperative `xfail`; a decision marked decided with no behaviour behind it; every
scenario deselected with `-m`; one deselected with `--deselect`; and a `publishCatalogue` operation
added to the contract.

## Cost

The child runs that prove the harness's own logic run concurrently and without a test database:
none of what they prove reaches the database, and a child that did would fail on pytest-django's
access guard. Each would otherwise create and migrate its own test database, which is where most of
their time went.

## Known limits

- The assertions after each scenario's first gap have never run against an implementation. They
  follow the specification as written and must be reviewed when the behaviour lands.
- Core is driven in process, not as a separate API process, and there is no worker process. The
  check that the API cannot read the worker's credential file needs both.
- The CI test job provides PostgreSQL only. Scenarios needing a real local identity provider stop
  at `harness:identity-provider-admission`; completing the slice needs a job that also starts a
  local identity provider and the worker.
- A run that deselects the population check itself and every scenario is not a population run and
  is not failed; CI's command selects both.
- Lease expiry is not in database time. `JOB_CATALOGUE.md` §1 and §4 compare leases in database
  time — the sweep selects `lease_expires_at < now()` in PostgreSQL — but the harness clock moves
  Python time only, so FS-CON-03's `clock.advance` past the 120-second lease expires nothing the
  sweep reads. A Python-side instant the worker could be handed instead would not conform to the
  specification. The harness therefore needs a way to move database time for one lease, such as
  back-dating the stale claim's lease row in the test database, and FS-CON-03 is to be reviewed
  when the worker lands.
- `service:realm-update` recognises a `kind`, in a request body or a query parameter, that admits
  `realm_update`, and operations named for a realm update, change, setting or sync. A free-form name
  such as `reconfigureRealm`, with no such `kind`, is not recognised.
- Admission reads provider endpoints from environment names that combine a provider word with an
  endpoint word; Core declares no provider configuration yet, so a differently named variable is not
  seen.

## Changelog

- First version: thirty-three scenarios, the inventory and its bound gaps, the synthetic adapters,
  the self-tests and eight mutation proofs.
- Makes the inventory authoritative for state; fails a population run with a deselected or missing
  scenario; admits the environment before any scenario runs; measures catalogue publication, the
  contract-backed services, the worker and identity provider admission instead of asserting them;
  follows the design of record on OD-1; replaces three placeholders with `ACCEPTANCE.md`'s assertions;
  encodes the eight minimum weakenings; runs the proofs' children concurrently without a database.
- Records the owner's slug decision: FS-ID-01 and FS-ID-02 are no longer blocked and measure the
  contract's slug patterns against 3–20 for organisations and 3–32 for tenants.
- Follows contract 0.10.0. The organisation slug rule is 2–20, not the 3–20 the entry above
  recorded, and the contract carries it and the tenant rule of 3–32, so FS-ID-01 and FS-ID-02 are
  expected failures on `operation:createOrganisation`. OD-1 is decided, `placeOrder` is
  `org_owner` only, so FS-BILL-01, FS-BILL-06 and FS-JOURNEY-01 move from blocked to expected
  failures on `service:catalogue-publication`: twenty-eight expected failures, five blocked.
- Follows contract 0.11.0. The organisation slug rule is 5–20, the owner's minimum, not the 2–20 the
  entry above recorded; the measured gap is `contract:organisation-slug-rule-5-20`. The population
  is unchanged: twenty-eight expected failures, five blocked.
- Follows accepted ADR-0004 and `docs/domain/JOB_CATALOGUE.md` §1 in the concurrency scenarios.
  FS-CON-01 takes the realm from the intake's own `realm_create` job, holds both provisions after
  each creates its own clients, then fails one with a non-retryable fault aimed at its correlation:
  it ends `failed` with its clients removed, the sibling ends `succeeded` with its clients, and the
  realm settings are unchanged. Compensation covering `provision` step 9 is the lead's ruling, and
  its weakening `compensate-before-step-9-only` is the ninth encoded. FS-CON-02 serves a
  `realm_update`, which holds the organisation lock exclusively, and a `provision`, which holds it
  shared, in both request orders, observing the first one hold its lock while the second waits,
  with a realm job in `other_org` unaffected; its weakening keeps its name and now shows a realm
  change running beside a held provision. FS-CON-03 checks the `fence`, expiring and sweeping the
  first claim before the second, and its weakening is renamed `allow-old-fence-dispatch`. FS-CON-05
  sets each provider outcome before the first run: absent and complete never enter
  `needs_reconciliation`, running and unresolvable stay there, with their reservations, through a
  second run. FS-CON-06 crashes after the intake's job write rather than an outbox write, since the
  `realm_create` job is the intake's durable record, counts its `JobStep` rows too, and its
  weakening is renamed `drop-durable-job`. The harness gains `Worker.sweep`, a measured
  `service:realm-update`, `NonRetryableFailureError` and per-correlation injection; FS-CON-02
  observes the held job's organisation reservation in its mode, and FS-CON-01's counterexample
  observes its provision `failed` before reading its clients. The manifest's
  FS-CON-01, -02, -03 and -06 descriptions follow the ADR ahead of the internal `ACCEPTANCE.md` they
  were transcribed from. No scenario's first gap moves: twenty-eight expected failures, five
  blocked.
- Follows the routed staff intake (`../specs/ORGANISATION_INTAKE.md`). Twelve expected failures move
  past `operation:createOrganisation`: FS-BOOT-01 and FS-BOOT-02 to
  `operation:getOrganisationBootstrap`, FS-OP-01 and FS-CON-06 to `harness:core-fault-points`, and
  FS-BOOT-03, -04, -05, -07, FS-ID-01, -02, -03 and FS-CON-03 to
  `harness:identity-provider-second-factor`, which a staff request now reaches. The fixture's staff
  issuer is also set as the settings' one staff issuer. Still twenty-eight expected failures, five
  blocked.
- Follows the catalogue models (`apps/billing`). `publish_catalogue` loads the placeholder catalogue
  through the operator's `load_catalogue` command, so the sixteen expected failures that stopped at
  `service:catalogue-publication` reach the staff intake and move to
  `harness:identity-provider-second-factor`. The mutation proofs' child runs get their own test
  database, since a scenario now reaches the database before its gap. Still twenty-eight expected
  failures, five blocked.
- Records the G1 owner-independent decisions. Organisation lifecycle, two-tier idempotency and
  external stop evidence are decided; invoice authority and retained access/identity erasure remain
  owner-gated. FS-OP-05 moves to its earlier `harness:identity-provider-second-factor` gap. The
  population is twenty-nine expected failures, four blocked and zero passing, pinned by the offline expected-red gate and its four mutation
  proofs.
- Records the delegated Core MFA consumer contract. FS-BOOT-06 and FS-OP-06 move to
  `harness:identity-provider-second-factor`, leaving the real Keycloak producer and evidence as SRE
  delivery work. The population is thirty-one expected failures, two blocked and zero passing.
- FS-OP-01 reads the exact `X-Operation-Ref` from complete and in-flight intake responses and
  compares it with the retained `realm_create` `Job.idempotency_key`. Its self-test deletes or
  malforms that header and refuses legacy body or `Location` substitutes. The scenario's remaining
  gap is only the named pre-commit Core fault point.
- Records the tenant-scoped retained-access window as a decided 90-day maximum with validated
  controller-requested earlier deletion. FS-LIFE-02 moves to its first implementation gap; only
  FS-LIFE-03 remains owner-blocked on one-time redelivery after identity erasure. The population is
  thirty-two expected failures, one blocked and zero passing.
- Wires Core's fault points (`core/faults.py`, `fault_points.toml`). FS-BOOT-02, FS-OP-01 and
  FS-CON-06 arm them for real, pass `harness:core-fault-points`, and stop at their next recorded
  gap, `harness:identity-provider-second-factor`, on the staff intake each crash or hold
  interrupts. `harness:core-fault-points` is now measured, against the worker scenarios' planned
  names. Still thirty-two expected failures, one blocked and zero passing.
