# Self-host Kodera Community Edition

Status: Active

This Docker Compose stack runs a single-node Kodera Community workspace: `Caddy` (automatic HTTPS), the `@kodera/web` client, the `apps/server` migrator and API, `room-access`, `PostgreSQL 17`, `Valkey 8`, `Synapse` and the `LiveKit` SFU.

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
# 3. Generate hex secrets (POSTGRES_PASSWORD, DJANGO_SECRET_KEY, HMAC and LiveKit secrets):
#      openssl rand -hex 32
# 4. Generate 32-byte base64url seal keys (KODERA_CONTACT_SEAL_KEY, KODERA_OUTBOX_SEAL_KEY):
#      openssl rand -base64 32 | tr '+/' '-_'
# 5. Check your .env before starting: it names keys only, never prints a value.
python3 ../../scripts/ci/check-community-deploy.py --preflight .env
docker compose up -d
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

- Synapse installs `kodera-synapse-policy` 0.1.4 from the local read-only package mount on every start, with `--no-index --no-deps --no-build-isolation`. No package download occurs. Keep the repository's `packages/synapse-policy` directory beside this deployment tree.
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

The optional `--template` selects one of the five workspace templates and writes
`<configuration-path>.workspace-template.json` without overwriting existing data.
This is a provisioning intent for an operator, not proof that remote channels or
connectors are active. The standalone `packages/create-kodera` package uses the same
template definitions.
