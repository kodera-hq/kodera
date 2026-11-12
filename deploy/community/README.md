# Self-host Kodera Community Edition

Status: Active

This Docker Compose stack runs a single-node Kodera Community workspace: `Caddy` (automatic HTTPS), the `@kodera/web` client, the `apps/server` migrator and API, `room-access`, `PostgreSQL 17`, `Valkey 8`, `Synapse` on its own `PostgreSQL 17` database, and the `LiveKit` SFU. The `community-governance` profile adds the Matrix-only tenant agent and persistent reconciliation state.

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
# 3. Generate hex secrets (POSTGRES_PASSWORD, SYNAPSE_POSTGRES_PASSWORD, DJANGO_SECRET_KEY,
#    HMAC and LiveKit secrets):
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

## Matrix sign-in

Members sign in to Synapse through your identity provider, never with a Matrix password: the web client sends the browser to Synapse's single sign-on, Synapse to your realm, and Synapse returns a single-use login token to the web origin. On every start `configure_synapse.py` therefore keeps password sign-in and open registration off, issues refreshable access tokens (the web client refuses a token that never expires) and, when a realm is configured, writes one OIDC provider:

- the confidential client **`synapse`** of your realm, with the callback `https://<KODERA_DOMAIN>/_synapse/client/oidc/callback`, PKCE S256 and back-channel logout;
- the Matrix localpart from the stable `sub` claim, never from an e-mail address or a mutable user name;
- `sso.client_whitelist` holding `https://<KODERA_DOMAIN>/` only, with its trailing slash: Synapse matches by prefix.

Which realm it is:

- **Canonical Community** (`KODERA_DEFAULT_COMMUNITY_ORG_SLUG=community`): the issuer is `KODERA_DEFAULT_COMMUNITY_ISSUER`. Leave `KODERA_SYNAPSE_OIDC_ISSUER` empty.
- **Isolated self-host:** set `KODERA_SYNAPSE_OIDC_ISSUER` to your realm's issuer, which must be admitted on the customer lane of `KODERA_AUTH_TRUST`, and `KODERA_SYNAPSE_OIDC_CLIENT_SECRET` to the secret your identity provider issued for the `synapse` client. The generator takes it with `--synapse-oidc-secret-file`.
- **Both empty:** Synapse starts with no sign-in at all. The control plane and the web client run, but nobody can open a Matrix session, so channels and audio rooms stay unavailable.

Synapse reads the realm's discovery document when it starts and refuses to start if it cannot reach it. A provider written by anyone else is never silently replaced: the start fails instead.

## What the internet can reach

Caddy is the only service that publishes HTTP ports. It routes:

| Path | To |
| :--- | :--- |
| `/api/*`, `/health/*` | the server API |
| `/_kodera/rooms/token` | `room-access` |
| `/_matrix/client/*`, `/_matrix/media/*`, `/_synapse/client/*` | Synapse's client API and its sign-in callback |
| `/rtc`, `/rtc/*` | LiveKit signalling |
| everything else | the web client |

**Caddy alone names the client.** For every upstream it overwrites `X-Forwarded-For` with the address of the peer it accepted, and drops `X-Real-IP` and `Forwarded`: a value a client sends in those headers never reaches Synapse or the API. The `Caddyfile` declares no `trusted_proxies`, because nothing sits in front of Caddy in this profile; if you put your own proxy or load balancer in front, that is a change to review, since Caddy would then see the proxy's address as every client's. Only Caddy and LiveKit publish ports on the host. Synapse, the API and the databases are reachable on the stack's internal network only, so the listener that believes the forwarded address cannot be called around Caddy.

It answers `404` on `/agent/*` and on every other `/_matrix/*` and `/_synapse/*` path. The agent API (`/agent/v1/...`) is for the tenant agent, which calls `http://server:8000` on the stack's internal network; Synapse's admin API (`/_synapse/admin/*`) is likewise reached by the agent only. LiveKit also publishes its media ports (7881/tcp, 50000–50060/udp).

## Synapse database

Synapse runs on PostgreSQL, in the dedicated `synapse-db` service (collation `C`, as Synapse requires), with its own password, `SYNAPSE_POSTGRES_PASSWORD`. That password reaches Synapse as `PGPASSWORD` and is not written to `homeserver.yaml`; the server API never holds it, and Synapse never holds the server's `POSTGRES_PASSWORD`.

Status: the upgrade path below is documented, not rehearsed in this repository.

A stack started from an earlier revision of this profile kept Synapse's data in SQLite (`homeserver.db` in the `synapse_data` volume). The stack no longer runs on it and never abandons it silently: when that file exists, Synapse refuses to start and says so. Before upgrading such a stack:

1. Stop `synapse` and back up the `synapse_data` volume.
2. Start `synapse-db` alone, then port the data with Synapse's own `synapse_port_db` tool, following the [Synapse PostgreSQL guide](https://element-hq.github.io/synapse/latest/postgres.html#porting-from-sqlite).
3. Move `homeserver.db` out of the volume (keep the backup), then start the stack.

## Upgrading an existing stack

A stack started from an earlier revision of this profile meets four changes. None is applied silently:

- **A new required secret.** Add `SYNAPSE_POSTGRES_PASSWORD` to your `.env` (`openssl rand -hex 32`). Compose refuses to start without it, and the preflight names it.
- **Synapse's data moves to PostgreSQL.** Port it first, as "Synapse database" describes; Synapse refuses to start while the SQLite file is still there.
- **Matrix password sign-in is off in every mode.** Members sign in through your identity provider ("Matrix sign-in"). An account that only ever had a Matrix password can no longer sign in.
- **`/agent/*` and the Matrix federation, key and admin paths are no longer routed by Caddy.** The tenant agent is unaffected: it calls the server on the internal network. Anything else that called those paths through your public domain must move inside the stack's network.

## Federation

Status: closed by default. Matrix federation is not part of the product yet; opening it is an operator's own decision and is not tested here.

By default the homeserver talks to no other server:

- `federation_domain_whitelist` is empty, no key server is trusted, and Synapse's listener serves the client API only;
- Caddy routes no `/_matrix/federation/*` or `/_matrix/key/*` path, and the federation port 8448 is not published.

To open federation to servers you name, and only those:

1. Set `KODERA_MATRIX_FEDERATION_ALLOWLIST` to their server names, comma-separated (`partner.example.org,other.example.org`). A wildcard or a private name is refused. Synapse then admits those servers only and serves the federation API on its listener.
2. Route the federation paths yourself, in your own copy of the `Caddyfile`: add `/_matrix/federation/*` and `/_matrix/key/*` to the `@matrix` matcher, and publish server discovery (`/.well-known/matrix/server` naming `<KODERA_DOMAIN>:443`).

The room policy still applies: a member may invite a user of another server only in a room whose `io.kodera.room.policy` allows it (see `packages/synapse-policy`).

## Images and limits

- Synapse installs `kodera-synapse-policy` 0.1.5 from the local read-only package mount on every start, with `--no-index --no-deps --no-build-isolation`. No package download occurs. Keep the repository's `packages/synapse-policy` directory beside this deployment tree.
- Fresh and existing Synapse configurations enable `kodera_synapse_policy.KoderaPolicy`. The tenant agent is `@kodera-agent:<domain>` and the occupancy writer is `@kodera-rooms:<domain>`; provision `ROOM_ACCESS_MATRIX_TOKEN` for that room-access account. The generated configuration preserves other operator modules and replaces the policy entry idempotently.
- Every pulled image is pinned by tag and digest (`name:tag@sha256:…`), matching the versions the CI runs where the CI runs them (Postgres 17.6, Synapse v1.163.0, LiveKit v1.13.10). The `server`, `migrate`, `room-access` and `web` images are built from this repository.
- Every service sets `mem_limit`.
- Synapse is rate limited (`rc_message`, `rc_registration`, `rc_login`, `rc_joins`, `rc_invites`). Every value is Synapse's documented default, written out so that a later default cannot loosen it, with one exception: **`rc_login.address` is 20 sign-ins, then one every 6 seconds**, where the default is 5, then one every 5.5 minutes. The default would lock out a team that shares one office address, and the web client signs in again on every reload. Password sign-in is off, so the only login an address can attempt is a single-use token that Synapse itself issued after your identity provider authenticated the member; failed attempts (`rc_login.failed_attempts`) and per-account sign-ins (`rc_login.account`) keep the default. The check refuses any value looser than these. One consequence of the per-account default: Synapse counts every sign-in of a member, a reload of the web client included, so a member who reloads more than five times in quick succession waits a few minutes for the next Matrix session.
- A per-address limit is only as good as the address. Synapse reads the client address from `X-Forwarded-For` on the one listener Caddy targets (port 8008) and on no other; see "What the internet can reach" for why that header can be believed.
- `scripts/ci/check-community-deploy.py` checks all of this, with the rest of this stack's invariants, on every change: it runs `configure_synapse.py` on a freshly generated homeserver and refuses SQLite, an open federation, a missing policy module, missing or loosened rate limits, a route to `/agent/*`, and a default in `.env.example` or the Compose file that looks like a secret. `--selftest` proves each check can fail.

## Security and secret isolation (`ADR-0003` and `ADR-0018`)

- `migrate` runs schema migrations in a dedicated one-shot container (`Dockerfile.migrator`) before `server` starts, keeping the customer-facing API container migration-free.
- `server` runs with `KODERA_BILLING_ENABLED=false` and receives **only** the application keys admitted by `ADMITTED_SECRET_NAMES`.
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `ROOM_ACCESS_MATRIX_TOKEN` are isolated inside `room-access` and `livekit`.
- `SYNAPSE_POSTGRES_PASSWORD` is isolated inside `synapse` and `synapse-db`.
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
connectors are active: the extensions a template names are reference
implementations in `extensions/`, and nothing in this stack installs or connects
them. The standalone `packages/create-kodera` package uses the same template
definitions and ships a checked copy of this directory's Compose assets.

The templates are `audiovisual-production`, `tech-studio`, `b2b-advisory`,
`public-sector`, `proximity` and `community`. `crisis-cell` is a permanent alias of
`proximity`, the name this template had before: it stays accepted and selects the
same template, and the manifest then records `proximity`. The template's
`#proximity` channel (`#proximité` in French) is an everyday proximity and presence
channel with a voluntary, pseudonymous check-in. It is not an emergency service
and does not replace emergency numbers.

## Canonical Community

Status: Repository profile and local policy verification; operator rehearsal required.

The `community` template creates the `Kodera Community` workspace through the
server's idempotent `bootstrap_community_workspace` command after both migration
profiles complete. It includes public Community channels, read-only announcements,
staff-only Core Kodera channels, an explicit-grant Design Partners category and the
`office-hours` voice room. Its provisioning manifest records this structure; the
server remains the authority that creates the rows and emits member/channel sets.
The manifest names the Design Partners category but not its rooms: those are
created and named by the server's bootstrap, one per partner, and are never public.
Bootstrap also creates the canonical tenant in `provisioning`; public web entry
remains gated until an authorized operator verifies the real backend and activates it.
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
  `@kodera-rooms:<domain>` token for room-access. Password sign-in is off from the
  first start, so the approved Synapse administrator procedure must issue their
  access tokens without a password login (Synapse's shared-secret registration API
  returns one). Keep credentials in protected operator files, never in version
  control or shell history.

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
python manage.py tenant_status --settings config.settings.deploy_operator list
python manage.py enrol_tenant_agent --organisation community --tenant <community-tenant-uuid> \
  --staff-identity <authorized-staff-identity-uuid> \
  --token-file /secure/new-community-agent-token \
  --settings config.settings.deploy_operator
```

Select the `community` tenant UUID from the status listing; the agent must be
bound to that tenant as well as the organization. The enrollment command creates
a new mode-0600 file and refuses to overwrite one;
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
unrelated isolated self-host, leave the three `KODERA_DEFAULT_COMMUNITY_*` values
and the two agent credential values empty, set or leave empty the two Synapse OIDC
values together (see "Matrix sign-in"), then start without
`--profile community-governance`.

`KODERA_MATRIX_DOMAIN` is the base domain, such as `kodera.io`, while
`KODERA_DOMAIN` is the full tenant hostname, such as `community.kodera.io`.
The web client derives the Matrix server name by prefixing the tenant slug;
passing the full hostname as its base domain would duplicate `community` and
prevent Matrix login. The generator and preflight refuse that mismatch for the
canonical template. Caddy routes Matrix and room-access on the tenant hostname;
a Matrix client-discovery 404 intentionally falls back to this same origin.

In canonical mode, Synapse requires the configured Community issuer and one OIDC
provider, forces PKCE, and derives the Matrix localpart from the canonical `sub`
claim, never from email. Password login and public Matrix registration are off in
every mode. It refuses to silently replace an unrelated existing OIDC provider. Its
generated configuration is mode 0600 because it contains the isolated
confidential-client secret. The tenant agent creates missing accounts bound to that
provider/subject.
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

After the staged accounts complete Matrix SSO and the agent's member/channel
commands are acknowledged successfully, record the readiness transition:

```bash
python manage.py tenant_status --settings config.settings.deploy_operator set \
  --staff-identity <authorized-staff-identity-uuid> --tenant <community-tenant-uuid> \
  --to active --reason 'Community backend acceptance verified'
```

This existing operator command requires the `staff_operator` grant and audits the
transition. Confirm `tenant_status list` reports the canonical tenant as `active`,
then verify an ordinary verified user's `/api/v1/auth/me` tenant entry is ready
and the real web client opens the Community workspace. An inactive tenant must
keep the workspace readiness gate closed; do not bypass it with a fixture or
manual database update.

### Governance rollback

Stop the `tenant-agent` service before changing a policy-producing server version.
Restore the reviewed API/web images and operator configuration together. Preserve
the database, Synapse data and agent-state volumes. Revoke a compromised agent
credential through the existing `revoke_tenant_agent` operator command and rotate
its isolated replacement; do not weaken Synapse policy to recover access. A policy
downgrade that removes additive governance fields needs an explicit review because
it removes the independent room-policy defense. Re-run canonical bootstrap and
the two-account negative checks after reconciliation before reopening traffic.
