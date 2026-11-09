# Host-side Core migrations

**Status:** Proposed · **Owner:** API seat

This procedure supplies the missing host-side invocation for Core's Django migrations. The
operator selects the artifact, database and maintenance window. It does not authorize a deployment,
change a database grant or establish staging/customer readiness. Required CI and real MFA remain
independent gates. Fleet's host/network recipe and the operator's artifact delivery remain separate.

## Preconditions

The operator MUST identify the exact reviewed source commit and its already available image.
Use an OCI digest, or a cached local image ID with a retained build record binding that ID to the
source commit. An image ID alone does not prove that binding. Do not substitute a mutable tag,
rebuild from an unreviewed checkout or pull a replacement when the selected artifact is absent.

Before a database change, the operator MUST record the current schema/image pairing, the proposed
migration plan, a qualified restorable backup and the applicable recovery procedure. Database
migration and application rollback are different operations: a previous application image is not
necessarily compatible with the new schema. Do not promise that reversing migrations will undo
a change. Stop if recovery or compatibility is unknown.

Only one migration operator may act on the selected database. Hold competing migration and
application writes according to the reviewed maintenance plan; this procedure does not install
a distributed migration lock. The PostgreSQL service MUST remain on its existing private network,
without a published database port. No production/customer target is implied by access to staging.

Prepare a dedicated root-readable environment file for this one-off process. Its required values
are DJANGO_SECRET_KEY, DJANGO_ALLOWED_HOSTS and DATABASE_URL, validated by
config.settings.deploy/config.deploy_environment. DATABASE_URL identifies the selected database
and a migration identity with the required schema rights. Do not expand the running API identity's
grants to make migration succeed, use PostgreSQL's superuser by default, or copy the API's entire
runtime environment. Include another application setting only when the selected migration actually
requires it and its use is reviewed. No cloud, SSH, mail/provider administrator or other
infrastructure credential belongs in this process. Never print the file or database URL.

The graph here is exactly the deployment API profile. That profile does not install apps.outbox;
its migrate/check result cannot establish operator, delivery/outbox or complete owner-claim schema
readiness. The separate operator profile and proposed checkout procedure below address the source
boundary; their artifact, applied schema and operational qualification remain separate. Do not
substitute local job_queue, test or e2e settings on the host to close that gap.
See [TESTING.md §5.1](TESTING.md#51-the-job-queue-acceptance-directory) for the existing profile distinction.

## Plan with the selected artifact

Set these local operator variables to reviewed values; the placeholders below are intentionally
incomplete. No secret is supplied as a shell argument or stored in the image.

```sh
CORE_IMAGE='sha256:<exact-cached-image-id>'
CORE_DATABASE_NETWORK='<existing-private-database-network>'
CORE_MIGRATION_ENV='<absolute-root-only-migration-environment-file>'
```

Inspect only nonsecret fields and verify the expected nonroot image identity and working directory:

```sh
docker image inspect "$CORE_IMAGE" \
  --format '{{.Id}} {{.Config.User}} {{.Config.WorkingDir}}'
```

The current Dockerfile uses `USER 10001:10001`, `WORKDIR /app` and `/opt/venv/bin/python`. Confirm these
for the selected artifact rather than adding a root override. A missing image is a stop.

Run the plan in a separate process, with no published listener, source/socket mount or pull:

```sh
docker run --rm --pull=never --read-only \
  --network "$CORE_DATABASE_NETWORK" \
  --env-file "$CORE_MIGRATION_ENV" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --entrypoint /opt/venv/bin/python "$CORE_IMAGE" \
  /app/manage.py migrate --settings=config.settings.deploy --plan --noinput
```

Review the actual named operations and dependencies. Do not infer correctness from a migration
count or from a previously observed staging count. Even planning loads migration code from the
selected artifact; review and database isolation remain necessary. Refuse unexpected destructive
operations or an artifact/target mismatch before applying anything.

## Apply and check

After the operator accepts the concrete plan and recovery prerequisites, run the same selected
image, database network and environment with only --plan removed:

```sh
docker run --rm --pull=never --read-only \
  --network "$CORE_DATABASE_NETWORK" \
  --env-file "$CORE_MIGRATION_ENV" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --entrypoint /opt/venv/bin/python "$CORE_IMAGE" \
  /app/manage.py migrate --settings=config.settings.deploy --noinput
```

Retain the exit status and applied migration identifiers, without environment/credential values.
On failure, stop rollout and use the reviewed recovery procedure. Do not retry blindly, use
--fake/--fake-initial, reverse migrations speculatively, delete retained rows or hand-edit the
schema to force the identity journey to pass.

Check pending migrations with the same artifact and process boundary:

```sh
docker run --rm --pull=never --read-only \
  --network "$CORE_DATABASE_NETWORK" \
  --env-file "$CORE_MIGRATION_ENV" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --entrypoint /opt/venv/bin/python "$CORE_IMAGE" \
  /app/manage.py migrate --settings=config.settings.deploy --check --noinput
```

A nonzero result blocks rollout. A successful result covers only the selected API migration graph. Restore the intended API runtime environment/identity only through
the operator's separately reviewed artifact recipe; never leave the migration identity in the API.
Then check the admitted HTTPS /health/live and /health/ready routes through the intended ingress.
A ready response proves database connectivity, not migration completeness, real MFA, claim issuance,
realm readiness or customer functionality. Test those boundaries with genuine inputs afterward.

## Separate operator profile and checkout artifact

**Status:** Proposed procedure; only hermetic checks have run (see Validation and limits).

`config.settings.deploy_operator` installs identity, organisations, jobs, audit and outbox; for
billing's staff command `settle_complimentary_order`, legal, tenancy and billing; support, for the
support ticket mails; and, for the tenant agent's staff commands `enrol_tenant_agent` and
`revoke_tenant_agent` (ADR-0016), engine intents. It has no URLconf, WSGI application or
middleware, and does not inherit local, test or API settings. Its environment validator has a fixed
operator selector; the API's fixed selector still refuses it.

`settle_complimentary_order` on this profile needs two more inputs, both validated as the API
validates them:
- `KODERA_INVOICE_SERIES`, set to the **API's own value** (the API defaults it to `INV` when
  unset). The credit note is numbered `AV-<series>-…` in one gapless counter per series, so the
  profile never defaults it: unset, the command refuses before it reads anything, and a series
  other than the one the credited invoice is numbered in is refused before anything is written.
- `KODERA_TENANT_APP_URLS`, the API's application URL templates, read only for the tenant line
  the command prints after it commits. Unset, that line shows `host=-`.

The operator's database identity needs what the settlement reads, locks and writes, as the API's
identity has it:
- billing: read and update on orders, invoices, payment links and subscriptions (locked
  `FOR UPDATE`), read on invoice lines and payments, insert on credit notes and their lines, and
  insert and update on the invoice number counter;
- identity: `FOR SHARE` on staff roles, identities and users, which PostgreSQL grants only with
  `UPDATE` on at least one column of each;
- read on organisations and tenancy, and insert on the audit record.

A role missing one of these fails the command with `permission denied` and rolls it back.

The tenant agent's commands, `enrol_tenant_agent` and `revoke_tenant_agent`, need the cutover
admitted (`KODERA_INTAKE_ADMITTED`; unset, both refuse before they read anything) and a staff
identity with a current `staff_operator` grant. `enrol_tenant_agent` writes the token once to a new
mode-600 `--token-file` on the operator host and never prints it. Carry it to the tenant host as
`KODERA_AGENT_TOKEN` through the reviewed secret-launch mechanism, never in a command argument,
shell history or log, then delete the file on the operator host. A token file lost or exposed is a
credential to revoke and enrol again. The operator's database identity needs, as the API's has it:
- identity: `FOR SHARE` on `identity_staffrole`, `identity_identity` and `identity_user`, which
  PostgreSQL grants only with `UPDATE` on at least one column of each;
- read on `orgs_organisation` and `tenancy_tenant`;
- `engine_intents_credential`: read and insert, and `UPDATE (state, revoked_at)`, which also
  admits revocation's `FOR UPDATE` on it;
- `engine_intents_command`: read and `UPDATE (state, finished_at)`, for the revoked agent's
  undelivered commands;
- insert on `audit_auditevent`.

No member-set or channel-set table is read or written. `engine_member_sets_lag`, the read-only lag
report, becomes discoverable here too; it is not this profile's to run.

Billing's other commands become discoverable here too, but only the settlement is supported on
this profile, and no deployed profile supports the others yet. `send_order_confirmations` (the
customer's notice of the credit note included) and `withdraw_cancelled_links` run under
`config.settings.job_queue` only. Do not bring the API's payment or mail secrets to the operator
host to run them. With no payment provider here, a payment link the settlement cancels is not
withdrawn at the provider: the command logs `not withdrawn at <provider>` and its commit stands,
and the link stays payable until the provider's session expires (at most 23 h 55 min for Stripe).
`load_catalogue` and `load_legal_documents` are discoverable here as well; they are not this
profile's to run, and `--allow-placeholder` is for development and tests only.

The API Docker context excludes the profile, operator commands, command-only staff constructor and
outbox. Do not widen that context or reuse the API image as the operator artifact.

The pilot's existing commands run from an independently prepared checkout on the dedicated operator
host described by FIRST_OWNER_BOOTSTRAP §3.7–3.8. Select an exact reviewed commit and an already
prepared dependency environment matching its Python requirement and locked runtime dependencies.
Record the source/dependency manifest and interpreter identity; verify the checkout is clean and
contains no local overrides, credentials or unreviewed code. Source qualification here does not
produce that artifact or authorize an installation, acquisition, build or host change. Stop when
the recorded artifact is absent; do not fall back to the API image, another checkout or local
settings. A future operator image needs its own explicit build context and acceptance.

The target is the same Core database as the API, not a new operator-only database. First qualify
and apply the API graph using the preceding procedure. Then plan the operator graph, which adds
outbox migrations while retaining the shared history of the API's applications. The operator graph
re-includes the identity, organisation, job, audit, legal, tenancy, billing, support and engine
intents migrations the API owns, so the operator checkout's commit MUST equal the selected API
image's source commit; otherwise its `migrate` can apply API schema ahead of the running image.
Refuse an operator `--plan` that contains any operation outside `outbox`: every other application
here is in the API's graph too (`config/settings/deploy.py`), so at the same commit the API has
applied it already. Do not infer standalone
schema completeness from the ten installed applications: generic `run_deliveries` selects all
due message templates, and an order confirmation reads/locks `billing_order`. Every queued
template's schema and required table rights must be present. A delivery limit does not filter
by template. Mixed-queue and cancellation-lock acceptance remain required before operating mail.

Keep migration and command identities separate. Inject a minimal reviewed process environment
through the operator's existing secret-launch mechanism; never include secrets in command
arguments, shell history, captured logs or source files. The profile requires DJANGO_SECRET_KEY,
DJANGO_ALLOWED_HOSTS and DATABASE_URL without local defaults, validates the fixed selector and
refuses infrastructure credentials even when empty. ALLOWED_HOSTS is validated deployment metadata,
not an HTTP serving instruction. No cloud, SSH or Keycloak administrator credential belongs here.

With CORE_OPERATOR_CHECKOUT and CORE_OPERATOR_PYTHON bound to that recorded artifact, use these
three separately reviewed steps, applying the same backup, serialization and recovery preconditions
as above. The migration process needs schema rights; its success grants no operator identity:

```sh
cd "$CORE_OPERATOR_CHECKOUT"
"$CORE_OPERATOR_PYTHON" -B manage.py migrate --settings=config.settings.deploy_operator --plan
"$CORE_OPERATOR_PYTHON" -B manage.py migrate --settings=config.settings.deploy_operator --noinput
"$CORE_OPERATOR_PYTHON" -B manage.py migrate --settings=config.settings.deploy_operator --check
```

Afterward, end the migration process and remove its access through the reviewed launcher. Existing
commands use a separately admitted command environment/identity, never the migration identity or an
expanded API role. Include the same KODERA_AUTH_TRUST, KODERA_STAFF_ISSUER,
KODERA_INTAKE_ADMITTED and KODERA_CONTACT_SEAL_KEY as the admitted API. Cutover stays closed
unless its real final declaration permits it. Outbox seal, SMTP transport, allowed link origins and
claim link/lifetime use their existing parsers and operation-level refusals. Unset mail settings
do not prevent migration/help, but cannot authorize delivery. The deployed profile retains STARTTLS
for remote SMTP and the existing plaintext loopback-only rule; it adds no insecure remote host.
`run_realm_deliveries` (MEMBERSHIP_LIFECYCLE §6.1.5) reads KODERA_REALM_WORKER_SECRET_DIR, a path
to the per-realm worker client secrets and never a secret value, plus KODERA_REALM_ISSUER_ORIGIN
and KODERA_REALM_ADMIN_ORIGIN, through the same parsers as job_queue. Unset, the command refuses;
one origin without the other or a malformed origin stops the process. The secret directory belongs
to the command identity only, never to the migration process or the API.

Do not enable intake, fabricate a staff grant, bind an owner, issue a claim or send mail merely
because startup/migration succeeds. FIRST_OWNER_BOOTSTRAP's recorded authority, distinct
recorder/binder, actual provider/readiness evidence, sealed contact, genuine delivery and real MFA
requirements remain. The commands' pilot database-access identity assertion remains the explicit
deviation of §3.7; the new profile does not replace it with verified staff authentication.

## Validation and limits

The image paths/profile and CLI options above are checked against the repository Dockerfile,
config.settings.deploy and the installed Django command help. No host migration was executed to
validate this document, and no backup/recovery, grant set, deployment or production compatibility
qualification is claimed. This procedure requires the operator's reviewed target-specific inputs;
it neither changes them nor contains them.

The operator profile is tested with synthetic explicit inputs while database and socket contact are
prohibited: Django setup, existing command discovery/parser help, the unconnected migration graph,
fixed selector/credential/trust/cutover/mail refusals and API image exclusions. This proves neither
actual PostgreSQL migration execution nor shared-schema compatibility, grant sufficiency, mail
delivery, operator artifact provenance or real identity-journey readiness.

## Changelog

- Adds an explicit one-off migration plan/apply/check procedure, preserving private database
  access, separate migration authority, immutable artifacts and truthful readiness limits.
- The operator profile installs engine intents for the tenant agent's staff commands
  (`enrol_tenant_agent`, `revoke_tenant_agent`), and states what they need: the cutover admitted, a
  `staff_operator` grant, how the token file is carried and deleted, and the exact table rights;
  corrects the operator graph's application list and count.
