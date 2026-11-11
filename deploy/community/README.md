# Self-host Kodera Community Edition

Status: Active

This Docker Compose stack runs a single-node Kodera Community workspace: `Caddy` (automatic HTTPS), the `@kodera/web` client, the `apps/server` migrator and API, `room-access`, `PostgreSQL 17`, `Valkey 8`, `Synapse` and the `LiveKit` SFU. The `community-governance` profile adds the Matrix-only tenant agent and persistent reconciliation state.

It runs **no identity provider**. Sign-in uses an OIDC issuer you already operate (see "Sign-in"), so plan for one before you start.

No installation time or memory footprint has been measured for this stack, and none is promised here. Every service has a `mem_limit`: those are ceilings that stop one service from starving the others, not a measurement.

## Before you start

- A Linux host with Docker Compose v2, a public DNS name for `KODERA_DOMAIN`, and ports 80, 443, 7881/tcp and 50000–50060/udp open.
- An OIDC issuer you operate, reachable over public `https`, whose realm URLs follow the `/realms/<name>/` layout the web client expects (a Keycloak-style layout). It does not run in this stack.

## Quickstart

```bash
cd deploy/community
cp .env.example .env
# 1. Set KODERA_DOMAIN and KODERA_ACME_EMAIL.
# 2. Set KODERA_OIDC_PROVIDER_ORIGIN and KODERA_AUTH_TRUST (see "Sign-in").
#    For the canonical shared workspace, complete "Canonical Community" below first.
# 3. Generate hex secrets (POSTGRES_PASSWORD, DJANGO_SECRET_KEY, HMAC and LiveKit secrets):
#      openssl rand -hex 32
# 4. Generate 32-byte base64url seal keys (KODERA_CONTACT_SEAL_KEY, KODERA_OUTBOX_SEAL_KEY):
#      openssl rand -base64 32 | tr '+/' '-_'
# 5. Check your .env before starting: it names keys only, never prints a value.
python3 ../../scripts/ci/check-community-deploy.py --preflight .env
docker compose --profile community-governance up -d
```

The preflight refuses to pass while any key of `.env.example` is missing or empty, while any `CHANGE_ME_` placeholder is left, or while `KODERA_AUTH_TRUST` and `KODERA_OIDC_PROVIDER_ORIGIN` do not name a public `https` issuer. Compose itself also refuses to start without `KODERA_AUTH_TRUST` and `KODERA_OIDC_PROVIDER_ORIGIN`.

## Sign-in

Two settings connect the stack to your issuer:

- **`KODERA_OIDC_PROVIDER_ORIGIN`**: the origin of your issuer, for example `https://id.example.org`. The web client is built with it and signs users in under its `/realms/<name>/` paths; the web server's Content-Security-Policy admits only that origin. It signs in as the public OIDC client `console`, so register a client with that id in your realm: the server admits a member's token only when its `azp` claim names `console` (or one of the native apps' clients, `kodera-ios` and `kodera-android`), and refuses any other.
- **`KODERA_AUTH_TRUST`**: the issuers the server trusts, as one JSON list on one line, in single quotes in `.env`. Each entry has exactly five fields:

  ```json
  [
    {
      "lane": "customer",
      "issuer": "https://id.example.org/realms/<name>",
      "generation": "<a label for this key set>",
      "expires_at": 1893456000,
      "public_jwks": { "keys": ["…the issuer's public signing keys…"] }
    }
  ]
  ```

  `lane` is `customer` for your members (`staff` is for operators). `issuer` must be a public `https` URL: a plain-`http` or loopback issuer is refused. `expires_at` is in Unix seconds and is checked on every request, so renew the entry before it lapses. `public_jwks` holds the issuer's public keys only. The server never fetches keys from the issuer: when the issuer rotates its keys, update this value and restart `server`. At most 8 entries. If the value does not parse, the server refuses to start.

## Images and limits

- Synapse installs `kodera-synapse-policy` 0.1.5 from the local read-only package mount on every start, with `--no-index --no-deps --no-build-isolation`. No package download occurs. Keep the repository's `packages/synapse-policy` directory beside this deployment tree.
- Fresh and existing Synapse configurations enable `kodera_synapse_policy.KoderaPolicy`. The tenant agent is `@kodera-agent:<domain>` and the occupancy writer is `@kodera-rooms:<domain>`; provision `ROOM_ACCESS_MATRIX_TOKEN` for that room-access account. The generated configuration preserves other operator modules and replaces the policy entry idempotently.
- Every pulled image is pinned by tag and digest (`name:tag@sha256:…`), matching the versions the CI runs where the CI runs them (Postgres 17.6, Synapse v1.163.0, LiveKit v1.13.10). The `server`, `migrate`, `room-access` and `web` images are built from this repository.
- Every service sets `mem_limit`.
- `scripts/ci/check-community-deploy.py` checks both, with the rest of this stack's invariants, on every change; `--selftest` proves each check can fail.

## Security and secret isolation (`ADR-0003` and `ADR-0018`)

- `migrate` runs schema migrations in a dedicated one-shot container (`Dockerfile.migrator`) before `server` starts, keeping the customer-facing API container migration-free.
- `server` runs with `KODERA_BILLING_ENABLED=false` and receives **only** the application keys admitted by `ADMITTED_SECRET_NAMES`.
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `ROOM_ACCESS_MATRIX_TOKEN` are isolated inside `room-access` and `livekit`.
- Licensed under [`Apache-2.0`](./LICENSE) (orchestration files); container images keep their own component licences (`Apache-2.0` for `@kodera/web`, `AGPL-3.0-or-later` for `apps/server`).

## Support

Questions about this stack: `support@kodera.io`. Security reports: see `SECURITY.md` at the repository root.

## Terminal configuration generator

From the repository root, prepare the external issuer's **public** trust registry as
`public-trust.json` (see Sign-in above), then run:

```sh
bash deploy/community/kodera-deploy.sh --domain chat.example.org \
  --oidc-issuer https://id.example.org/realms/studio \
  --oidc-origin https://id.example.org --support-mailbox support@example.org \
  --oidc-client-id console --template audiovisual-production \
  --trust-file public-trust.json --env-file kodera-generated.conf --generate-only
```

The generator creates mode-0600 configuration with independent random secrets, refuses
an existing destination and prints the exact Compose startup command. It starts no
services. Keep this generated file outside version control. Use `--preflight-only
--env-file <path>` to run the Community preflight on operator-owned configuration.
`--selftest` uses temporary synthetic configuration, deletes it on completion and
never reads an existing deployment configuration. The tool supplies no OIDC provider.

The optional `--template` selects a workspace template and writes
`<configuration-path>.workspace-template.json` without overwriting existing data.
This is a provisioning intent for an operator, not proof that remote channels or
connectors are active. The standalone `packages/create-kodera` package uses the same
template definitions.

## Canonical Community

Status: Repository profile and local policy verification; operator rehearsal required.

The `community` template creates the `Kodera Community` workspace through the
server's idempotent `bootstrap_community_workspace` command after both migration
profiles complete. It includes public Community channels, read-only announcements,
staff-only Core Kodera channels, explicit-grant Design Partners channels and the
`office-hours` voice room. Its provisioning manifest records this structure; the
server remains the authority that creates the rows and emits member/channel sets.
The web image already enforces `VITE_AUTH_MODE=oidc` and `VITE_ENABLE_MSW=0`.

Before starting this profile, the operator must have:

- The Community server changes providing `bootstrap_community_workspace`,
  canonical identity binding and `KODERA_APPS=matrix` tenant-agent mode in the
  reviewed image source.
- A verified public `community` Keycloak realm, client `console` with exact web
  callbacks, and confidential client `synapse` with callback
  `https://<KODERA_DOMAIN>/_synapse/client/oidc/callback`, PKCE S256 and back-channel
  logout. Follow the operations repository's `keycloak-ops/MONOREPO-REALMS.md`.
- A real, enabled owner `User` UUID already in the server database. Bootstrap
  refuses a missing owner; it does not create an administrator from an email
  address. For a completely fresh database, complete the approved owner/staff
  provisioning procedure before enabling the canonical bootstrap setting.
- A current staff identity holding `staff_operator`, with its exact
  `KODERA_STAFF_ISSUER` also admitted on the staff lane of the public trust array,
  for the one-time tenant-agent enrollment.
- Issued Synapse service-account credentials: administrator
  `@kodera-agent:<domain>` for reconciliation and the separate
  `@kodera-rooms:<domain>` token for room-access. Provision them through the approved
  Synapse administrator procedure before disabling password login. Keep credentials
  in protected operator files, never in version control or shell history.

The isolated tenant agent uses `python -m tenant_agent run`, polls the internal
`http://server:8000/agent/v1/commands` API, applies canonical members/channels to
Synapse, and periodically reconciles again. It requires no Docker socket or cloud
credential. Its issued `KODERA_AGENT_TOKEN`, Synapse administrator token and LiveKit
credentials never enter the API or migration process. The initialization service
only sets ownership of the dedicated state volume; the agent runs as the server
image's nonroot user. Do not share or delete that state volume during a rollback.

### Bootstrap, enroll and start

These are human-operated commands. Use the same reviewed public trust and issuer
settings for the migration and API profiles. From `apps/server` in the approved
operator environment, bootstrap and then enroll:

```bash
python manage.py bootstrap_community_workspace --owner-user-id <existing-owner-uuid> \
  --settings config.settings.deploy_operator
python manage.py enrol_tenant_agent --organisation community \
  --staff-identity <authorized-staff-identity-uuid> \
  --token-file /secure/new-community-agent-token \
  --settings config.settings.deploy_operator
```

The enrollment command creates a new mode-0600 file and refuses to overwrite one;
it does not print the issued token. Prepare the separate Synapse administrator
token and the Keycloak `synapse` client's issued secret in equally protected files.
Then generate configuration from the repository root:

```bash
bash deploy/community/kodera-deploy.sh --template community \
  --domain community.example.org --matrix-domain example.org --support-mailbox support@example.org \
  --oidc-origin https://id.example.org \
  --oidc-issuer https://id.example.org/realms/community \
  --staff-issuer https://id.example.org/realms/kodera-staff \
  --owner-user-id <existing-owner-uuid> --trust-file /secure/public-trust.json \
  --agent-token-file /secure/new-community-agent-token \
  --synapse-token-file /secure/synapse-agent-token \
  --synapse-oidc-secret-file /secure/synapse-client-secret \
  --env-file /secure/kodera-community.conf --generate-only
python3 scripts/ci/check-community-deploy.py --preflight /secure/kodera-community.conf
docker compose --env-file /secure/kodera-community.conf \
  -f deploy/community/docker-compose.yml --profile community-governance up -d
```

Replace example domains with the exact reviewed hosts, including
`community.kodera.io` for the public deployment. The generator never invents issued
agent or identity-provider credentials; Community mode requires the credential
files and owner UUID. The generic templates leave the canonical settings empty
and omit the governance profile. When manually adapting `.env.example` for an
unrelated isolated self-host, leave the three `KODERA_DEFAULT_COMMUNITY_*` values,
the two agent credential values and the Synapse OIDC client secret empty, then
start without `--profile community-governance`.

`KODERA_MATRIX_DOMAIN` is the base domain, such as `kodera.io`, while
`KODERA_DOMAIN` is the full tenant hostname, such as `community.kodera.io`.
The web client derives the Matrix server name by prefixing the tenant slug;
passing the full hostname as its base domain would duplicate `community` and
prevent Matrix login. The generator and preflight refuse that mismatch for the
canonical template. Caddy routes Matrix and room-access on the tenant hostname;
a Matrix client-discovery 404 intentionally falls back to this same origin.

In canonical mode, Synapse requires the configured Community issuer and one OIDC
provider, forces PKCE, disables password login and public Matrix registration,
and derives the Matrix localpart from the canonical `sub` claim, never from email.
It refuses to silently replace an unrelated existing OIDC provider. Its generated
configuration is mode 0600 because it contains the isolated confidential-client
secret. The tenant agent creates missing accounts bound to that provider/subject.
See the [Synapse OIDC configuration](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#oidc_providers)
for the PKCE and mapping options.

Foreign-issuer and staff API membership does not invent a canonical Matrix
subject. For a proven existing Community account, the operator binds it with
`python manage.py bind_community_identity --user-id <user-uuid> --subject
<canonical-community-sub> --settings config.settings.deploy_operator`. Validate the
subject against the identity service before binding; never link by matching email.

### Required cutover evidence

Re-run bootstrap after the real owner is bound and the agent is enrolled; this
emits the desired member/channel sets again. In the running profile, verify the
agent's one-shot convergence with:

```bash
docker compose --env-file /secure/kodera-community.conf \
  -f deploy/community/docker-compose.yml --profile community-governance \
  run --rm tenant-agent python -m tenant_agent reapply
```

This exit status alone is insufficient when no command has been consumed yet.
Confirm successful member-set and channel-set results in the control plane, then
use two real staged accounts to verify that `#support` is usable, ordinary members
cannot post in `#announcements`, reactions still work, and Core Kodera/Design
Partners rooms remain hidden and reject joins/invites. Inspect each room's
agent-authored `io.kodera.room.policy`: announcements have `read_only: true` and
explicit `exempt` publishers; restricted rooms have `audience: listed` and only
authorized Matrix IDs in `members`. Verify the matching room power levels too.
Complete signup/email/OTP, Matrix SSO, support ticket creation and voice-room
checks before switching public traffic. A configuration render or database
bootstrap is not proof that these services are ready.

### Governance rollback

Stop the `tenant-agent` service before changing a policy-producing server version.
Restore the reviewed API/web images and operator configuration together. Preserve
the database, Synapse data and agent-state volumes. Revoke a compromised agent
credential through the existing `revoke_tenant_agent` operator command and rotate
its isolated replacement; do not weaken Synapse policy to recover access. A policy
downgrade that removes additive governance fields needs an explicit review because
it removes the independent room-policy defense. Re-run canonical bootstrap and
the two-account negative checks after reconciliation before reopening traffic.
