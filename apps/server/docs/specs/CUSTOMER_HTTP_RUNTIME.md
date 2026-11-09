# Customer HTTP runtime qualification

**Status:** Local image qualification passed at `a11bd17857e1e430ffe72e7d0feca5e3766062a6` · **Owner:** API seat

The accepted synthetic image run recorded37 actual READ WRITE42501 statement refusals, two separately recorded startup denials with SQLSTATE null, four provider/image HTTP cases, and real database pause/outage plus same-process persisted recovery. Source hashes and independent owned-resource cleanup passed. This uses the fixed local WSGI qualification server; it is not a production deployment or serving-process qualification. Preparation and follow-up notes below preserve their historical pre-run states.

## Scope and ownership

This controller preparation starts from the qualified persistence commit `d78f3ad11d45cfde505ae8149c8ab035009e5e7a` and follows the separately reviewed customer HTTP technical binding. It does not implement HTTP, model, token-verification, Dockerfile or IAM policy. The HTTP implementation owner supplies the customer profile, route, narrow image inclusion and externally selected image probes. The controller owner supplies only `dev/accept_customer_http.py`, its focused tests and this specification. No image build or service run is admitted by test collection or the initial absence failure.

The intended command after integration and coordinated runtime admission is `.venv/bin/python dev/accept_customer_http.py`. There is no arbitrary command, target URL, database name or credential input. Everything belongs to this synthetic invocation. No cloud, first-owner intake, contact verification/MFA ceremony, provisioning, rate-limit or persistent audit qualification is implied.

## Existing source seams

| Existing source | Reuse and limit |
|---|---|
| `dev/accept_runtime.py` | Pinned PostgreSQL image and fixed-argument Docker primitive; reuse image/build/sentinel approach, not its older broad lifetime assumptions |
| `dev/identity_fixture.py` | Pinned provider image; `fixture_realm`, `LoopbackHTTP`, `code_flow`, `CALLBACK`, `REALM`; no duplication of PKCE/nonce/state/cookie handling |
| `services/identity/access_tokens.py` | Existing public snapshot parser and signature verifier; no private JWT parsing or altered kernel |
| `config.settings.persistence` and actual migrations | Owner-side migration and synthetic insertion only; no API migration credentials |
| Future `config.settings.customer_http` | Actual route/profile inside the image; supplied by the HTTP owner |
| Future `dev/customer_http_image_acceptance.py` | Four explicitly selected real-image probes; missing controller input must fail, never silently skip |
| `dev/accept_persistence.py` | Measured disk/resource bounds, monotonic readiness and verified cleanup patterns; no second generic lifecycle framework |

The existing provider context manager creates its own PostgreSQL and uses older cap/cleanup handling. This controller reuses its protocol functions and fixture data, while owning its small resource sequence directly. No modification to the frozen provider/token source is required.

## Exact owned topology

Use one unique owner label, one ordinary bridge network and three uniquely named containers: PostgreSQL, identity provider and API. Every published listener binds127.0.0.1 with a Docker-selected free port. No host network, Docker socket, broad repository mount, existing resource mutation or additional ingress service is needed. Cache-only image references use the exact admitted digests and `--pull=never`; the future API image build uses the HTTP owner's exact reviewed Dockerfile/context and existing pinned base layers. External service/base images must already be cached. The standard build may acquire only the exact locked and hash-verified Python dependencies, without credential/SSH forwarding; keep the reviewed Dockerfile/lock unchanged, a 600-second build bound and disk reserve. No host virtual environment is copied into the Linux image.

PostgreSQL uses512MiB memory/swap,1CPU,256MiB tmpfs; provider1GiB memory/swap and1CPU; API256MiB memory/swap and1CPU, read-only root,64MiB `/tmp` tmpfs, all capabilities dropped and no-new-privileges. Inspect those actual API flags and reject known infrastructure/provider/owner environment variable names even when empty. Each has capped logs. Maintain5GiB free disk before every build/service/test phase and after cleanup. Readiness loops have overall monotonic deadlines and short individual commands. Capture only public inspect metadata: image IDs, ports, caps, mounts and ownership labels; never persist complete container environment inspection.

The same owned PostgreSQL cluster hosts `kodera_server` and `identity`, with distinct database logins. Provider credentials are scoped to its identity database. Revoke PUBLIC CONNECT on both databases; grant the customer reader CONNECT only to `kodera_server`. It must fail connecting to `identity` and cannot assume the identity or owner role. The API receives no owner, provider, administrator, migration or fixture credential.

## Reader role and actual privilege probes

After owner-side migrations/fixtures, provision one synthetic LOGIN role with no superuser, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS or inheritance. It owns no object and belongs to no direct or transitive role membership that grants access. Grant schema USAGE and SELECT only on these five existing tables:

- `identity_user`
- `identity_identity`
- `orgs_organisation`
- `orgs_membership`
- `orgs_slugreservation`

Revoke PUBLIC schema CREATE, database TEMP and application-schema function EXECUTE in this disposable database; grant the reader no application function execution. Do not grant future/default table privileges. Create an owner-only sentinel table after grants and prove reader SELECT refusal there. Inspect effective table privileges and effective column privileges (including column-only INSERT/UPDATE/REFERENCES grants), plus role membership/ownership. Require no writable column grant or SELECT column outside the five named relations; table-level privilege checks alone are insufficient.

Run every write/DDL/escalation probe in an explicit READ WRITE transaction, inspect transaction_read_only=off, then execute the actual statement. Only insufficient_privilege42501 is acceptance.25006, integrity CHECK/FK failures, syntax errors, connection errors and generic exceptions do not establish privilege denial. Always roll back. Both direct owner/coordinator and reader connections use connect_timeout=2, lock_timeout=5000 and statement_timeout=30000; timeout SQLSTATE57014/55P03 cannot count as privilege denial. Named probes cover INSERT/UPDATE/DELETE/TRUNCATE on customer tables, ALTER TABLE, trigger disabling, database CREATE SCHEMA, schema CREATE TABLE, CREATE TEMP TABLE, SET ROLE to owner/provider login, SELECT on the later sentinel table, and application function EXECUTE. A SELECT of actual customer data must pass first; a connection failure cannot stand in for a table privilege test.

The function EXECUTE probe uses an owner-created synthetic application function after PUBLIC execute removal, after revoking the owner’s default PUBLIC EXECUTE grant for future application functions. The reader must receive42501. Retain actual role/catalog facts, and for every executed refusal record its fixed probe label, observed transaction_read_only=off and actual SQLSTATE. Record identity/postgres semantic startup denials separately, retaining their actual nullable SQLSTATE and fixed exception category. Never retain connection strings or fixture values. Reader access to a newly created table remains denied; no default SELECT grant is added to make testing convenient.

## Actual provider, persistence and image path

Create the existing synthetic realm/client fixture with an audience mapper for `kodera-server`. Reuse actual authorization-code+PKCE flows for access/ID/refresh material and the existing client without that audience. Imported fixture emailVerified/password values are fixture setup only, not proof of contact verification or MFA.

Read the provider's public JWKS through the bounded owned transport. Construct the finite public trust entry from the owned expected issuer, public snapshot, generation and future snapshot expiry. Verify the real access token with the existing signature verifier before using its issuer/subject to seed the corresponding existing customer Identity. Neither unverified payload parsing nor email is allowed to select the persisted person. Compare every expected binding to the known owned realm; no issuer URL from the token is fetched.

Seed one active organisation, permanent matching reservation, person, identity and active accepted owner using the actual migrated models in one owner-side transaction. Build expected Me independently from those stored fixture identifiers/fields according to the agreed projection, never by copying an API200 response. The API starts with the reader's DATABASE_URL, `config.settings.customer_http`, allowed loopback hosts and public KODERA_AUTH_TRUST only. Inspect its environment in memory and refuse any owner/provider password or forbidden credential name without printing values.

The external image input contains exactly api_port, access_token, id_token, refresh_token, wrong_audience and expected_me. Use a unique temporary directory0700 and an exclusively created regular file0600, with64KiB total JSON bound and16KiB per token. Refuse symlink/overwrite paths. The token file is supplied only to the explicitly selected image test process through KODERA_HTTP_ACCEPTANCE_INPUT and removed in finally, including failed tests. No token file, bearer material, token hash or full request/response dump enters retained artifacts. Logs must not include pytest locals containing this input.

Invoke the HTTP owner's external probes through their documented CLI/pytest seam once available. Assert real-image200 equals the independent persisted expectation, repeat ETag stability/no-store, and401 for actual ID/refresh/wrong-audience material. Do not select external-image tests in the normal suite without actual controller input.

## Image boundary and outage

The builder owns a precise Docker source allowlist. The controller constructs an owned build context with the reviewed source plus synthetic forbidden files under newly admitted `apps/` and `services/` directories, and existing `.env`, `.git` and worker sentinels. Inspect the actual built image for required runtime files and prove every forbidden path/content absent. A broad COPY with a convenient empty directory is not this proof. The image manifest and excluded paths are agreed with the HTTP builder before build; no guessed wildcard closure is approved here.

With a real reader-authenticated image request already passing, label-validate and pause only the owned PostgreSQL container. Do not stop/start the tmpfs database: that destroys the state needed for this proof. In a finally block, revalidate ownership and unpause before any cleanup removal, including after a failed request. Inherited `config/environment.py` sets CONN_MAX_AGE=0, libpq connect_timeout=2 and statement_timeout=2000; the HTTP profile inherits these unchanged. Use a fresh bounded connection for each HTTP request. The same still-running API must return actual HTTP500 for `/me` and503 readiness, with safe problem bodies and no-store; liveness remains200. A client/socket timeout or connection exception is a failed qualification, never an HTTP500. Unpause the same database, wait with bounds, and require readiness200 plus the byte-equivalent decoded persisted `/me` projection. Capture API container ID and StartedAt before the pause and after recovery and require both unchanged and Running=true; restarting it would not prove recovery. The outage also affects the synthetic provider's database, but Core's fixed token/snapshot verification needs no provider network access. Complete within the real token lifetime or acquire a fresh real token explicitly; never suppress expiry checks.

## Runnable controller acceptance before implementation

`tests/test_customer_http_controller.py` defines the intended small helper interfaces in the future controller. Its initial presence probe fails explicitly while that file is absent. Pure tests exercise exact READ WRITE/42501 classification, table and column capability refusal, reader-only environment projection, private bounded ephemeral image-input behavior, actual outage response classification, same-process recovery, label-checked pause/finally-unpause, and required/forbidden image source observations. These are helper controls, not proof that PostgreSQL privileges or a Docker image exist. Real acceptance above runs only after the controller and HTTP image are admitted.

The controller exposes `run_reader_probe(connection, statement)`, `require_reader_catalogue(facts)`, `api_environment(reader_password, public_trust)`, and `private_image_input(directory, payload)`. The first executes BEGIN READ WRITE, SHOW transaction_read_only, the supplied fixed controller statement and ROLLBACK; its caller never passes user SQL. The catalogue helper consumes only the controller's actual owner-side catalog query facts. The image-input context returns its private Path and guarantees deletion. These functions support this one sequence and are not a reusable permissions or lifecycle framework.

Freeze spec/tests, collect without services, and record the controller's named absence assertion before implementation. The initial packet collected 35 tests and its selected presence probe failed with `customer HTTP runtime controller is absent`. The corrected pre-code packet collected 57 cases and repeated the named absence failure. The controller now passes 77 pure cases and eleven selected source weakenings. Four additional missing/mismatched unsafe outage problem cases first failed against the initial controller, then passed after requiring the exact existing error shape. These are offline results; actual reader/database/provider/image/outage execution remains unexecuted. Subsequent resource and privilege controls require selected weakening proofs: accepting25006; granting a forbidden capability; leaking an owner/environment key; retaining a token file after failure; admitting an excluded source sentinel; accepting outage401/403/empty200. Mutations must use isolated sources/resources and fail their targeted assertion, not setup/import errors.

The fixed local image command uses `wsgiref.simple_server` with `config.wsgi.application`; this is a synthetic qualification server, not a deployment recommendation. Django runserver is unsuitable here because its migration check reads django_migrations outside the five-table grant. Do not expand privileges to accommodate that development command.

## Changelog

- Specifies a bounded controller over existing provider and persistence protocols, with actual reader-role/image/outage proof and no transferred runtime claim.
- Pins token-file lifetime, privilege SQLSTATE semantics and narrow source ownership before controller implementation.

- Corrects tmpfs outage to owned pause/unpause, bounds fresh database handshakes, and adds column privilege and source-boundary controls before controller code.

- Implements one synthetic controller sequence and records offline controls; actual runtime admission and independent qualification remain separate.

- Preserves API root/capability hardening and records actual identity CONNECT refusal after independent source review.

## Owned-cluster database connection scope

Status: Narrow source follow-up implemented after its failing acceptance; actual runtime remains unexecuted.

The database-scope claim includes the fixed owned cluster's default postgres and template1 databases. Revoke PUBLIC CONNECT and TEMP on these two databases as well as kodera_server and identity, before starting the provider. Inspect actual pg_database entries with datallowconn and effective has_database_privilege: the reader's connectable list must equal [kodera_server], and the provider's must equal [identity]. A later extra connectable database is a refusal, not an ignored catalogue field. Explicitly attempt reader connections to postgres and identity; require actual permission denial through the finite measured startup classifier below, with no fabricated SQLSTATE. Keep five application-table grants and owner/provider/reader roles unchanged. These statements target only the single freshly created owned PostgreSQL container; no shared or production cluster is modified.

Pure acceptance first updates the positive catalogue shape and adds extra-database negatives for both reader and provider. The old implementation must fail the new complete positive shape; a focused mutation must demonstrate that ignoring an extra effective CONNECT grant fails the selected negative. Real catalogue/CONNECT results remain pending the coordinated image qualification.

The new complete positive catalogue initially failed against the previous controller, while the two extra-database negatives refused as expected. After the narrow implementation,79 pure controller cases pass and13 exact source weakenings are caught, including separate reader/provider effective CONNECT omissions. This verifies the catalogue classifier and source binding only; actual database permission inspection and both semantic startup denials require the admitted runtime execution.

## Safe runtime failure diagnostics and TCP readiness

Status: Acceptance-first follow-up after preserved failed image-runtime01. No cause is inferred from its generic failure, and no diagnostic runtime has been executed.

Emit one fixed phase identifier before each meaningful controller phase and a closed failure object containing only that phase, a fixed exception category, a valid five-character SQLSTATE when available, and a fixed Docker subcommand category/integer return code for a failed Docker call. Never print exception text, command arguments, environment, SQL parameters, captured stdout/stderr, token material or HTTP bodies. Unknown phase/category values must not be reflected. Diagnostic recording must not make a failure pass or change finally cleanup.

The known source-integrity risk also requires child_environment to propagate only PYTHONDONTWRITEBYTECODE=1 in addition to its existing benign allowlist. Do not broadly forward parent environment or relax the frozen-source check for generated bytecode.

The failed phase permits an owner TCP-connect race hypothesis: the old pg_isready invocation checks a Unix socket, which can become ready independently of the final TCP listener. Earlier runtime helpers use the same socket predicate and do not establish this immediate TCP precondition. Before correction, freeze an owned pinned PostgreSQL experiment that starts a final socket-only server: default pg_isready must return0 while explicit127.0.0.1:5432 must not. A separate ordinary TCP-start control must return0 for the explicit predicate. These actual controls demonstrate predicate insufficiency, not the historical cause of runtime01. Service execution waits for the integration lead's command/resource review. The production controller readiness predicate must use explicit loopback TCP with its existing bounds.

Pure acceptance checks exact phase/failure shapes, absence of secret sentinel reflection from database and subprocess exceptions, unknown-value refusal, unchanged failure classification, explicit TCP readiness arguments and only the intended child bytecode environment addition. Required mutation controls must catch leaked diagnostics, omitted bytecode suppression and a socket-only readiness weakening.

The reviewed actual cached-image experiment completed before the TCP edit: a confirmed final socket-only PostgreSQL process returned socket0/TCP2; a separate final normal process returned socket0/TCP0. Both ran sequentially with512MiB memory,1CPU,256MiB data tmpfs, network none and no published ports, with exact owner-label/name cleanup independently verified. This proves the old readiness predicate admits a process with no TCP listener. It does not recover the unknown historical cause of image-runtime01. The controller now checks explicit127.0.0.1:5432 before its first owner TCP connection.

The diagnostic follow-up passes87 pure controller cases and16 exact source weakenings. A real main-entrypoint failure control confirms the diagnostic object is emitted without sentinel reflection, the original failure still raises and cleanup still runs. The first TCP mutation anchor check refused after formatting moved its indentation; that setup failure was retained and the exact anchor corrected before measuring the final intended refusal. No mutation setup failure is counted as a caught weakening. Whole-repository Ruff and mypy pass. These are source/controller controls; the corrected image has not run.

## Optional provider tmpfs observation

Status: Acceptance-first metadata-only correction after preserved image-runtime02. No change to API, memory/swap/CPU or owned-volume enforcement.

Resource observations must accept a provider HostConfig with omitted Tmpfs or an explicit empty map, and report those cases as an empty map. A real configured tmpfs map must still be retained exactly. The provider has no tmpfs option in its fixed command; absence of optional metadata must not prevent reporting otherwise valid resource bounds. Wrong memory, swap or CPU and unexpected owned volumes remain refused. Add all positive shape controls and retained-boundary negatives before the one-field read correction.

A pure unchanged-source counterexample reproduced KeyError for absent Tmpfs after otherwise valid provider metadata. Optional further evidence may inspect one never-started owned cached provider container, only after confirming the image declares no volumes. That control has no secrets/data, no networking, bounded caps and exact cleanup; it does not recreate or prove the deleted runtime02 container's state. Actual full corrected image qualification remains pending review and the heavy slot.

The cached provider image declared no volumes. One labeled, never-started container of that exact image showed state=created, running=false, PID0, no mounts, network none, bounded1GiB/1CPU and an absent HostConfig.Tmpfs key. It was removed after owner verification and exact name/label absence was checked. This confirms a legitimate Docker metadata shape without recreating the deleted failed container or starting a workload. The one-field observation correction now passes94 pure controller cases and17 selected weakenings; existing cap/volume refusal tests pass. No corrected full image qualification has run.

## Default function privileges in the owned database

Status: Acceptance-first correction after preserved image-runtime03 reader-catalogue refusal.

Remove the owner's global default PUBLIC EXECUTE grant before creating any later function. A schema-scoped default REVOKE cannot remove the global default grant, as documented by [PostgreSQL 16](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html). Keep the existing revocation on all already-created public functions and the strict empty application_execute catalogue expectation. This changes only the disposable owned fixture database's provisioning; it does not change product roles, migrations or runtime image inputs.

The approved actual pinned PostgreSQL control demonstrated the distinction: schema-scoped REVOKE left effective reader EXECUTE true and actual function execution succeeded; global REVOKE made a subsequently created function's effective EXECUTE false and actual reader execution returned SQLSTATE42501. The single socket-only container used network none, no published ports,512MiB memory,1CPU and256MiB data tmpfs; owner/name cleanup was verified. This proves a provisioning defect without reconstructing the deleted runtime03 catalogue or assigning its historical offending field.

Before the one-line edit, an offline acceptance captures the real provision_reader statement sequence through the later CREATE FUNCTION boundary and requires the global revocation to have occurred first. It does not simulate PostgreSQL authority or replace the actual paired control. A selected source mutation must restore the schema-scoped revocation and fail this named acceptance. The actual full reader catalogue,37 statement42501 refusals, two semantic startup denials, four image cases and outage/recovery remain pending a separately admitted runtime attempt.

The named acceptance first failed with new functions retain global PUBLIC EXECUTE. After the one-line global revocation correction,95 pure controller cases and18 selected source weakenings pass. The retained PostgreSQL paired control proves the underlying default-grant semantics; these offline checks bind that corrected statement to provisioning. Whole-repository Ruff and mypy pass. The corrected full image attempt remains unexecuted.

## Measured startup denial and reader privilege dimensions

Status: Acceptance-first correction after actual consolidated PostgreSQL controls; no application source change.

Pinned psycopg3.3.5 reports actual identity/postgres startup permission denial as OperationalError with no SQLSTATE. Same credentials connect to core; wrong credentials, missing database and an actual paused-server timeout have a different diagnostic predicate. Accept only the finite identity/postgres targets and an actual42501 error, or the measured exact OperationalError with absent code and the fixed quoted database permission-denied text. A timeout, another error type/code, unmatched message or unexpected successful connection must fail. Emit only the actual nullable code, fixed category, fixed target and semantic startup-denial marker. Never manufacture42501 or print the error/credentials. This classifier is used after positive same-reader core SELECTs and exact effective catalogue verification.

The catalogue must additionally require database_create=false, table_select_grant_options=[] and column_select_grant_options=[]. Measure the database CREATE privilege separately from role CREATEDB and public-schema CREATE. Inspect effective SELECT WITH GRANT OPTION on application tables and columns, including the five allowed SELECT tables. Add an actual reader CREATE SCHEMA statement to the existing READ WRITE42501 probes. Current provisioning stays unchanged: deliberate owner-added CREATE and table/column grant-option counterexamples proved the old catalogue could miss those added capabilities, with actual reader schema creation or delegation succeeding and rollback restoring the baseline.

Report37 actual statement42501 refusals separately from two semantic database startup denials. Preserve five positive table SELECTs, exact catalogue facts, four pending image token cases and real outage/recovery. The separately observed large-object write/readback under READ WRITE and25006 under READ ONLY limits the claim to five application-table SELECT grants plus the named privilege checks. It does not imply an API write across the enforced read-only transaction; no blanket built-in revocation is introduced.

Before code, add pure closed-diagnostic/finite-target/contradictory-code/privacy controls, complete catalogue positive and extra-privilege negatives, effective-query dimension mapping and CREATE SCHEMA probe binding. These offline query fixtures test wiring only; actual authority evidence comes from the preserved PostgreSQL controls and the future admitted full image run. Selected mutations must fail named assertions for accepting arbitrary startup errors, fabricated codes, skipped privilege dimensions and omitted CREATE SCHEMA. All38 actual image/build inputs must remain unchanged.

The expanded acceptance first produced17 intended missing-classifier/new-fact/schema-binding failures with98 passing cases. After the narrow correction,115 pure controller cases and28 exact source weakenings pass. Whole-repository Ruff and mypy pass. The separate actual PostgreSQL controls establish startup diagnostic shape and the CREATE/delegation counterexamples; query fixtures only bind those dimensions to this implementation. All38 image/build inputs remain unchanged. The subsequent accepted image run at `a11bd17857e1e430ffe72e7d0feca5e3766062a6` completed the37 statement refusals, two semantic startup denials, four HTTP cases and outage/recovery requirements. All166 tracked source hashes remained exact; only previously admitted pytest cache files were generated. The original failed attempts remain separate historical evidence.

## Privileges the workspace operations add

The reader role above holds `SELECT` on five tables and nothing else; it serves the customer reads only. `getWorkspace` and `initialiseWorkspace` ([`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md) §9) need, in addition, and nothing more:

- `SELECT` on `jobs_job` and `audit_auditevent` (the setup state), on `workspaces_workspace`, `workspaces_category`, `workspaces_channel`, `workspaces_resourcepolicy` and `workspaces_resourcepolicyrule` (the structure), and on `idempotency_record` (the replay store);
- `INSERT` on `workspaces_workspace`, `workspaces_resourcepolicy`, `workspaces_category`, `workspaces_channel`, `audit_auditevent` and `idempotency_record`;
- `UPDATE (default_policy_id)` on `workspaces_workspace` (binding the default policy) and `DELETE` on `idempotency_record` (an expired entry is replaced).

They are not granted to the reader. They are part of the least-privilege API writer role of the staff intake, `dev/api_writer_role.py` ([`ORGANISATION_INTAKE.md`](ORGANISATION_INTAKE.md) §4), which `tests/test_workspace_writer_role.py` exercises through both workspace operations (`tests/test_intake_writer_role.py` covers the intake's). The image qualification above still exercises only the customer reads.
