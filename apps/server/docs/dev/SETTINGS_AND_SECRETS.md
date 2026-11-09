# Settings and secrets

**Status:** Proposed · **Owner:** API seat

ADR-0003 says the API process holds no infrastructure credential. That is not a deployment convention; it is a property the code proves about itself. This document says how settings are declared, which variables are **banned** in the API process, and how the worker loads credentials for the duration of one job.

## 1. Settings

- Settings come from the environment through `django-environ`, the reader frozen in the tech baseline. Every setting is declared once in the settings module, with its type, its default and whether it is required. Reading `os.environ` anywhere outside the settings module is rejected by a lint rule.
- Layout:

```text
config/settings/
├── base.py        # everything common; declares every setting
├── dev.py         # local compose stack
├── test.py        # CI and local test runs
├── staging.py     # staging
└── prod.py        # production
```

Each environment module imports `base` and overrides; none of them declares a setting `base` does not know about. A setting that exists only in one environment is still declared in `base`, with a default that makes its absence obvious.

- **No secret has a default.** A required secret with no value raises at startup. A development-only value lives in the committed `.env.dev`, which contains no real credential and is asserted by a test to contain none.
- **No conditional imports on the environment name** inside application code. Behaviour differences are settings, not `if settings.ENV == "prod"` branches scattered through services.
- Naming: `KODERA_<AREA>_<NAME>`, upper snake. Durations end in `_S`, sizes in `_BYTES`, booleans read as statements (`KODERA_API_REQUIRE_MFA_FOR_STAFF`).
- Every setting appears in `.env.example` with a comment saying what it does and, for a secret, where the real value comes from. A test asserts that the declared settings and `.env.example` agree.

## 2. What the API process may hold

| Allowed | Why |
|---|---|
| Postgres connection details for its own database | It is the system of record |
| The Keycloak **issuer base URL** and the expected audience | Public information; used to verify tokens |
| Object-storage read credentials for artefacts it serves by reference | Narrow, read-only, per-bucket |
| Mail-sending credentials for transactional messages to customers | Not an infrastructure credential |
| a billing-provider restricted key limited to Checkout Sessions (create and expire), and the webhook signing secret. No refund, payout, transfer or full secret key; the key's scope is set and checked when it is issued | No money movement from the API |
| The audit pepper and the application signing key | Application secrets, not infrastructure |
| The Key Manager key **identifier** | An identifier, not a key |

## 3. What the API process must never hold

These are the **banned environment variables**. Their presence in the API process is a fatal error, not a warning.

| Banned | What it would grant |
|---|---|
| `SCW_SECRET_KEY`, `SCW_ACCESS_KEY`, `SCW_DEFAULT_ORGANIZATION_ID` with organisation scope | Provider control over every project |
| `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`, any master-realm client secret | Every tenant's identity |
| `SSH_PRIVATE_KEY`, `SSH_CA_KEY`, `ANSIBLE_PRIVATE_KEY_FILE` | Shell on every tenant host |
| `SOPS_AGE_KEY`, `SOPS_AGE_KEY_FILE`, `AGE_IDENTITY` | Every secret in the fleet |
| `TF_TOKEN_*`, `TF_VAR_*` carrying credentials, state-backend write keys | The state files |
| Backup bucket **delete** or lifecycle credentials | The backups |
| Key Manager **unwrap** credentials | Every envelope-encrypted value |
| DNS zone write credentials for the parent zone | The whole naming surface |

**The assertion that proves ADR-0003.** `tests/architecture/test_adr_0003.py` closes the four channels a credential could reach the API by — environment, setting, mount and import — each with a planted-credential mutation. As first specified, it:

1. imports the production settings module with each banned variable set in turn, and asserts startup **fails** with a named error;
2. asserts that the API's process-level guard runs before any request is served, and that it enumerates the banned list from a single constant rather than from a duplicated literal;
3. asserts that no module reachable from the API's import graph imports `worker.credentials`;
4. asserts that no code path in `apps/` or `core/` calls a provider client, an SSH client, an ACME client or a Key Manager unwrap operation;
5. is accompanied by its **self-test mutation**: a fixture that removes one entry from the banned list and asserts the test then fails, so the guard cannot silently become empty.

The guard itself runs at application startup in every environment, including development, so a developer discovers a misconfiguration on their machine rather than in staging.

## 4. Worker credentials

The worker has no inbound network and loads what one job needs, when that job needs it. Its network is internal and holds the database alone, with one limit compose cannot close: a container on an internal network can still reach the host through its bridge gateway; the host firewall must drop worker-network → host traffic except to the database. It also executes outbox deliveries — commercial effects, messages and user-level identity operations, which ADR-0004 keeps out of the job model — and loads what one delivery needs for that delivery only, in the same way.

| Credential | Scope | Lifetime | Loaded from |
|---|---|---|---|
| Provider API key | one project, one tenant | the job | Secret Manager, per job |
| SSH certificate | one tenant principal | ≤ 8 hours | SSH certificate authority, per job |
| Ops age identity | shared ops secrets; not target-isolated, so `lab` and `staging` only (ADR-0003) | the job, memory only | Secret Manager, per job |
| Key Manager unwrap | one key identifier | one step | Key Manager, per step |
| Keycloak realm-management account | one realm | the job, or the one outbox delivery (an invitation, an enrolment, disabling a user) that needs it | Secret Manager, per job or per delivery |

Rules:

- `worker/credentials/` is the only package permitted to fetch a credential. No other package may import it, and only `worker/steps/` receives the values it yields. Until the scheduler lands, lane decision W5 keeps the realm delivery an external one-shot command whose admin client imports it; `tests/architecture/test_adr_0003.py` holds the importers to that closed list. Which step receives the values is not tested yet: `worker/steps/` does not exist.
- Credentials are obtained through a context manager that guarantees they are cleared when the job or the delivery ends, including on failure. Nothing is written to disk except where a tool requires a file, in which case the file lives in a per-job directory removed on exit and is never inside the repository or a shared temporary directory.
- **Nothing is loaded into the process environment.** Credentials are passed to subprocesses through an explicit environment dictionary for that call only, so a crash dump or a child process cannot inherit them.
- A step declares which credentials it needs; the runner refuses to run a step whose declaration does not cover what it asks for. Escalation is impossible by construction rather than by review.
- Rotation is a job (`rotate_secret`), and the worker never holds a long-lived copy of anything it rotates.

## 5. Tenant secrets

- Stored envelope-encrypted: a data key per secret, wrapped by a key-encryption key in Key Manager; the ciphertext and the wrapped key live in the `Secret` row ([`../domain/MODEL.md`](../domain/MODEL.md) §7).
- The API stores and serves **metadata only**: name, version, state, rotation timestamps, key identifier. A serializer test walks every response schema and fails if `ciphertext`, `wrapped_dek` or any token hash appears.
- Decryption happens on the tenant host that serves the secret, from the reference the agent pulls; values are written mode 600 and preferred in `*_FILE` form so they do not sit in a container's environment.
- The worker unwraps only when a step must hand a value to a tool, and only for that step.

## 6. Secret hygiene in the repository

- Secret scanning and push protection are on; a secret scanner runs in pre-commit and in CI.
- `.env.dev` is committed and contains only obviously fake values; a test asserts every value in it matches a fake pattern.
- Fixtures, factories and snapshots contain no real credential, no real customer domain, and no real address.
- A log line, a job artefact and an audit diff never contain a secret value. [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md) §4 sets the redaction rules for audit diffs; each audit writer applies them at its call site, and no central pass enforces them yet. For log lines, the drop-and-count processor [`OBSERVABILITY.md`](OBSERVABILITY.md) §1 requires is not implemented yet, so nothing enforces this rule for them today.

## 7. What a reviewer checks

- [ ] The setting is declared once in `base.py`, typed, documented in `.env.example`.
- [ ] Nothing reads `os.environ` outside the settings module.
- [ ] No banned variable is introduced, and the banned list stays in one constant.
- [ ] A new credential need is satisfied in the worker, per job, through `worker/credentials/`.
- [ ] Nothing puts a credential in the process environment.
- [ ] No secret value can appear in a response, a log, an artefact or an audit diff.

## Changelog

- First version. Fixes part of assessment item C7: typed settings per environment, the banned-variable list for the API process with the startup guard and the test that proves ADR-0003 (with its own self-test mutation), and the worker's per-job credential loading with per-step scoping.
- Adds the per-delivery lifetime ADR-0004 gives the worker's outbox deliveries: the realm-management account a user-level identity operation needs is loaded for that one delivery and cleared when it ends, like a job's credentials. Limits the shared ops age identity to `lab` and `staging`, as ADR-0003 as accepted does.
- §4's rule on `worker/credentials/` no longer says an architecture test asserts it: none exists yet, and one comes with the package.
- §3's assertion exists: `tests/architecture/test_adr_0003.py`. The banned list gains the whole `TF_` prefix, the OpenTofu state backends' credentials (`GOOGLE_`, `CONSUL_HTTP_`, `PG_CONN_STR`; `AWS_`, `ARM_` and `SCW_` were already banned) and `ANSIBLE_PRIVATE_KEY_FILE`. A deployed profile also refuses the known credential-file selectors (`KUBECONFIG`, `PGPASSFILE`, `DOCKER_CONFIG`, `NETRC` and others, `config/environment.py`) and any credential-shaped name that is not one §2 admits. It refuses the known credential names and shapes; it does not claim to exclude every credential. The worker refuses the same list in its own environment (`config.settings.deploy_worker`).
- §2's billing row names what the API holds: a restricted key limited to Checkout Sessions and the webhook signing secret, never a full secret key. `apps/billing/configuration.py` refuses any key but a restricted one, and `tests/test_billing_restricted_key.py` proves it.
