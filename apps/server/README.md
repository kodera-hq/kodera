# kodera-server (`apps/server`)

Status: Customer API handlers, persistence and job-runner mechanisms are implemented in source. The deployment API profile exposes the operations below; production infrastructure provisioning remains gated by an empty worker registry and its recorded gaps. Source and local acceptance do not establish a production deployment or complete customer-release qualification.

Control-plane API and job-processing code for **Kodera**. The architecture covers organisations, plans, subscriptions, tenants, domains, jobs and audit, with intended infrastructure execution on Scaleway `fr-par`. The current production worker registers no job kind, so that infrastructure integration remains gated.

Control-plane API, worker, and tenant agent (`apps/server`) in the Kodera monorepo. Architectural decisions live in [`docs/adr/`](docs/adr/).

The GitHub repository is `kodera-hq/kodera`. Workspace clone directories such as `kodera-server` and `deployment operations` retain their existing names. Hosts, realms, API audiences and contract identifiers also retain their technical names until separately migrated; the product name alone does not change them.

## What this repo is

- **Core API** (Django 6.1 + DRF + Postgres): implemented identity/discovery, organisation intake/bootstrap/owner claims, membership and workspace administration. The [deployment settings](config/settings/deploy.py) select the [customer routes](config/customer_urls.py), consumed by the Console, native clients and admitted operators. The broader system-of-record architecture includes tenant state, domains, releases, backups, probes, jobs and audit.
- **Provisioning worker** (separate process, no inbound network): a [runner](worker/runner.py) with database-backed queue leases and step dispatch. Its [production registry](worker/registry.py) is empty, with five recorded gaps and provider binding still open. OpenTofu, Ansible and per-job provider credentials describe the intended infrastructure boundary; production provisioning is not enabled by the existing runner.
- **Agent API**: implemented engine command [pull, acknowledgement and result handlers](apps/engine_intents/api/views.py). The broader heartbeat/vitals/command contract remains in the [Agent API contract](contracts/agent-api.openapi.yaml); handler presence does not establish rollout to tenant VMs.
- **Billing and legal**: implemented [catalogue, order, subscription, invoice, credit-note and payment-link operations](apps/billing/api/views.py), plus [legal documents and DPA operations](apps/legal/api/views.py). Provider configuration and live payment acceptance remain separate from these source capabilities.

## What this repo must never contain

- An infrastructure credential reachable from the API process. Organisation-level Scaleway keys, Keycloak master-realm rights, SSH keys, and age identities exist only in the worker, loaded per job from Scaleway Secret Manager (ADR-0003).
- Customer personal data in logs, error reports, or fixtures.
- Tenant secrets in plaintext (ADR-0003).
- A tenant profile. Profiles (compose + `x-kodera` extension) live in `deployment profiles`, vendored by commit SHA, rendered in a sandboxed Jinja environment.
- A direct call from the console to Keycloak, Scaleway, or a tenant VM. Everything goes through the Core API and a job.

## Boundaries

```text
kodera-console ──HTTPS──▶ Core API ──▶ Postgres job queue ──▶ Provisioning worker ──▶ Scaleway / Keycloak / tenant VMs
                                 ▲                                        │
                                 └──────────── agent heartbeats ◀─────────┘ (from every tenant VM)
```

- Every mutation of infrastructure is a `Job` with an idempotency key, a lease, ordered steps, and an `AuditEvent`, committed in the same transaction as the desired-state change (ADR-0004).
- Tenant admins authenticate against their organisation's Keycloak realm; staff use the `kodera-staff` realm. The API never holds master-realm rights; delegated admin uses a per-realm `realm-management` service account.
- No Kubernetes (ADR-0002).

## Data model

One Django app per area under [`apps/`](apps/): `orgs` (organisations, memberships, invitations, owner claims), `identity` (users, identities, staff roles), `billing` (plans, packs, prices, orders, invoices, credit notes, payments), `legal` (documents, DPA, acceptances), `tenancy` (tenants), `workspaces` (Espace categories, channels, resource policies), `engine_intents`, `jobs`, `outbox` and `audit`. Hosts, IP addresses, domains, releases, backups and probes are not modelled yet.

## Contracts owned here

- **Core and Agent APIs**: [`contracts/core-api.openapi.yaml`](contracts/core-api.openapi.yaml) and [`contracts/agent-api.openapi.yaml`](contracts/agent-api.openapi.yaml); see the [contract guide](contracts/README.md).
- **Tenant profile extension** `x-kodera` schema: owned by `deployment profiles` at `schemas/x-kodera.schema.json`, referenced by commit SHA rather than copied here (see the [contract guide](contracts/README.md)).

## Development

- Python 3.12, Django 6.1, DRF, a Postgres-backed job queue built here (`apps.jobs`), OpenTofu, Ansible. Node is not needed here. The frozen toolchain, with a justification per entry, is [`docs/dev/BASELINE.md`](docs/dev/BASELINE.md).
- `uv sync --python 3.12 --locked` then `.venv/bin/python dev/accept_runtime.py` builds and tests uniquely owned disposable PostgreSQL/API containers. The development `app` profile serves diagnostics only through [its URL configuration](config/urls.py). The [separate worker](worker/__main__.py) verifies its boundary and database access, then exits without claiming work while its production registry is empty. See [`dev/README.md`](dev/README.md) and the [runtime acceptance contract](docs/dev/RUNTIME_BOOTSTRAP.md).
- `make lint`, `make typecheck`, `make test`, `make precommit`.
- CI: lint, typecheck, tests on Postgres, gitleaks, actionlint, conftest policy on rendered compose, `makemigrations --check`. Gates that guard code which does not exist yet are visibly skipped, never silently green. Nothing merges to `main` without a green run; [`AGENTS.md`](AGENTS.md) names the pull requests that need more than that.
- Environments: `staging` (with its own Keycloak) before production. `lab` is a tenant, not a staging.

## Conventions

See [`AGENTS.md`](AGENTS.md). English everywhere except user-facing product copy. Feature branch + pull request, never a direct commit to `main`. One-line commit messages on the why. No attribution trailers.

## Delivery scope

The local runtime bootstrap establishes health and database behavior within its
stated acceptance scope. Implemented customer API and job mechanisms have their
own source, specifications and bounded acceptance; their presence does not
establish live provider integration, production provisioning or complete
collaboration readiness. The production worker serves no kind while its registry
and recorded gaps remain as documented.
The first customer release remains gated on the complete approved product
scope, not on this runtime or an internal demonstration.
