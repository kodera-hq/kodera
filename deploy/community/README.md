# Self-host Kodera Community Edition

Status: Active

This Docker Compose stack runs a single-node Kodera Community workspace, in one of two topologies (see "Topologies"): `Caddy` (automatic HTTPS), the `@kodera/web` client, the `apps/server` migrator and API, `room-access`, `PostgreSQL 17`, `Valkey 8`, `Synapse` on its own `PostgreSQL 17` database, and the `LiveKit` SFU. The `community-governance` profile adds the Matrix-only tenant agent and persistent reconciliation state.

It runs **no identity provider**. Sign-in uses an OIDC issuer you already operate (see "Sign-in"), so plan for one before you start.

The hosted qualification below measures startup and idle footprint for one isolated run. Every service has a `mem_limit`: those are ceilings, not measurements or production capacity guarantees.

## Measured fresh-volume startup

In a fresh hosted Linux x86_64 qualification run with four logical CPUs and Docker 29.4.2, the runner built the checked-in images and started ten services on new project-owned volumes. The [successful qualification log](https://github.com/kodera-hq/kodera/actions/runs/43631347569/job/132558742760) records PR head `78d080d3adae5eef2739a8a12690a514eb372ecd` and tested merge source `ea86e42e25779cb552f50a6673f1003c07c6e5de`.

| Measurement | Observed value |
| :--- | ---: |
| Sequential image builds (server, migrator, collaboration, web) | 137.845 s |
| Compose startup to healthy, after builds | 70.543 s |
| Startup through all HTTP checks and the web entry asset, after builds | 72.801 s |
| Idle interval before sampling | 30 s |
| Sum of container working sets (`docker stats --no-stream`) | 434.562 MiB |
| Sum of reported container CPU percentages | 0.78% |
| Sum of process RSS (`docker top`, KiB) | 976,700 KiB (953.809 MiB) |

The container snapshot was: API 130.2 MiB, Synapse 119.9 MiB, Synapse database 54.95 MiB, Core database 38.09 MiB, collaboration 26.32 MiB, room access 21.69 MiB, LiveKit 14.56 MiB, web 12.64 MiB, Caddy 12.61 MiB and Valkey 3.602 MiB. Working set and process RSS measure different things; summing RSS can count shared pages more than once. CPU is the sum of Docker's reported percentages, not a normalized whole-host percentage.

The run checked actual liveness/readiness JSON, Matrix versions, the web document and its built JavaScript asset; federation and Synapse administration returned `404` through ingress. It used synthetic public trust, loopback ingress and an internal TLS certificate, with OIDC sign-in and the optional governance profile disabled. It establishes boot and route behavior, not sign-in, media, federation interoperability or loaded production capacity. Disk stayed above 82.588 GiB; project containers, volumes, local image tags and private temporary configuration were removed, with cleanup verified. The mandatory CI controller is `deploy/community/accept_coldstart.py`; each run emits its own evidence rather than treating these observations as a target.

## Before you start

- A Linux host with Docker Compose v2, public DNS names for the topology you choose (`KODERA_DOMAIN` for `single`; see "Topologies" for `split`), and ports 80/tcp, 443/tcp and 443/udp, 7881/tcp and 50000–50200/udp open.
- An OIDC issuer you operate, reachable over public `https`, whose realm URLs follow the `/realms/<name>/` layout the web client expects (a Keycloak-style layout). It does not run in this stack.

## Quickstart

```bash
cd deploy/community
cp .env.example .env
# 1. Set KODERA_DOMAIN and KODERA_ACME_EMAIL.
# 2. Set KODERA_OIDC_PROVIDER_ORIGIN and KODERA_AUTH_TRUST (see "Sign-in").
#    For the canonical shared workspace, complete "Canonical Community" below first.
# 3. Generate hex secrets (database passwords, DJANGO_SECRET_KEY,
#    KODERA_MEMBERSHIP_CURSOR_KEY, ROOM_ACCESS_MATRIX_TOKEN, LIVEKIT_API_SECRET):
#      openssl rand -hex 32
# 4. Generate the 32-byte standard base64 discovery HMAC key (KODERA_DISCOVERY_HMAC_KEY):
#      openssl rand -base64 32
# 5. Generate 32-byte base64url keys (KODERA_CONTACT_SEAL_KEY, KODERA_OUTBOX_SEAL_KEY,
#    KODERA_COLLAB_TICKET_KEY):
#      openssl rand -base64 32 | tr '+/' '-_'
# 6. Check your .env before starting: it names keys only, never prints a value.
python3 ../../scripts/ci/check-community-deploy.py --preflight .env
docker compose --profile community-governance up -d
```

The preflight refuses to pass while any key of `.env.example` is missing or empty, while any `CHANGE_ME_` placeholder is left, while a 32-byte standard base64 or base64url key has the wrong encoding or length, or while `KODERA_AUTH_TRUST` and `KODERA_OIDC_PROVIDER_ORIGIN` do not name a public `https` issuer. Compose itself also refuses to start without `KODERA_AUTH_TRUST` and `KODERA_OIDC_PROVIDER_ORIGIN`.

## Topologies

`KODERA_TOPOLOGY` selects one of two layouts. Both run from the same `docker-compose.yml`; nothing else changes between them, and `scripts/ci/check-community-deploy.py` checks both.

| | `single` (default) | `split` |
| :--- | :--- | :--- |
| Web client | `https://<KODERA_DOMAIN>/`, served by this stack | `https://<KODERA_DOMAIN>/`, served by **another** static host |
| Core API | `https://<KODERA_DOMAIN>/api/*` | `https://api.<KODERA_MATRIX_DOMAIN>/api/*` |
| Matrix client API, `room-access` | `https://<KODERA_DOMAIN>/_matrix/*`, `/_kodera/rooms/token` | `https://matrix.<KODERA_DOMAIN>/_matrix/*`, `/_kodera/rooms/token` |
| LiveKit signalling | `wss://<KODERA_DOMAIN>/rtc` | `wss://livekit.<KODERA_DOMAIN>/rtc` |
| Compose files | `docker-compose.yml` | `docker-compose.yml` and `docker-compose.split.yml` |
| Caddy configuration | `Caddyfile` | `Caddyfile.split` |

In both, the Matrix server name is `KODERA_DOMAIN`, federation stays closed and the same services, images, limits and secret isolation apply. `npx create-kodera` and the quickstart above produce the `single` topology.

### The split topology

Use it when the web client is a static site hosted elsewhere (for example `https://community.example.org`) and this stack serves the backends only. With `KODERA_DOMAIN=community.example.org` and `KODERA_MATRIX_DOMAIN=example.org`:

- **DNS:** `api.example.org`, `matrix.community.example.org` and `livekit.community.example.org` point at this host. `community.example.org` points at the static host, not here.
- **`.env`:** `KODERA_TOPOLOGY=split` and `DJANGO_ALLOWED_HOSTS=api.example.org,127.0.0.1,server` (admitting internal `http://server:8000/agent/v1/commands` polling from `tenant-agent` while Caddy answers `404` on `/agent/*` and `/staff/*` publicly). The generator writes both with `--topology split`; the preflight refuses a split `.env` whose allowed hosts are not `api.<KODERA_MATRIX_DOMAIN>,127.0.0.1,server`, or whose `KODERA_DOMAIN` is not below `KODERA_MATRIX_DOMAIN`.
- **Start:** `docker compose -f docker-compose.yml -f docker-compose.split.yml up -d` (add `--profile community-governance` for the canonical workspace). Synapse refuses to start when `KODERA_TOPOLOGY` and the Compose files disagree, so a split `.env` started without the override, or the reverse, fails visibly.
- **Firewall:** 80/tcp, 443/tcp and 443/udp for Caddy; 7881/tcp and 50000–50200/udp for LiveKit media (its `use_external_ip` setting advertises the host's public address). Nothing else.

What `docker-compose.split.yml` changes, and nothing more:

- Caddy reads `Caddyfile.split`: three site blocks, `api.<KODERA_MATRIX_DOMAIN>`, `matrix.<KODERA_DOMAIN>` and `livekit.<KODERA_DOMAIN>`. Each routes only its own upstreams, with the paths of "What the internet can reach", and answers `404` on every other path, so `/agent/*`, `/_matrix/federation/*`, `/_matrix/key/*`, `/_synapse/admin/*` and `/.well-known/matrix/server` all answer `404`.
- The `web` service is not started (it is moved to the `single-origin-web` profile, which this topology never enables).
- Core, room-access and Yjs collaboration admit `https://<KODERA_DOMAIN>`. To host the web client at a second origin, pass `--app-origin https://app.example.org` to the generator or set `KODERA_APP_ORIGIN` in the split deployment's environment file. Each service then admits both exact origins. The additional origin must use HTTPS on a dedicated subdomain of `KODERA_MATRIX_DOMAIN` so browser requests to `/api/v1/auth/discover` are same-site. Discovery rejects requests marked `Sec-Fetch-Site: cross-site`.
- Room-access hands out `wss://livekit.<KODERA_DOMAIN>` as the signalling URL.
- Synapse publishes `public_baseurl: https://matrix.<KODERA_DOMAIN>/`. Caddy strips upstream CORS grants on Matrix routes and returns the requesting origin only when it matches a configured web origin. Responses vary by `Origin`.

The static host must:

- publish `GET https://<KODERA_DOMAIN>/.well-known/matrix/client` returning `{"m.homeserver":{"base_url":"https://matrix.<KODERA_DOMAIN>"}}` with `Access-Control-Allow-Origin: *`, because Synapse no longer answers on the server name;
- proxy `GET https://<KODERA_DOMAIN>/.well-known/apple-app-site-association` and `GET https://<KODERA_DOMAIN>/.well-known/assetlinks.json` to `https://api.<KODERA_MATRIX_DOMAIN>` when iOS Universal Links or Android App Links are configured for `<KODERA_DOMAIN>` (see "Mobile app association");
- serve a web client built with `VITE_AUTH_MODE=oidc`, `VITE_ENABLE_MSW=0`, `VITE_CORE_API_URL=https://api.<KODERA_MATRIX_DOMAIN>/api/v1`, `VITE_KEYCLOAK_URL=<KODERA_OIDC_PROVIDER_ORIGIN>` and `VITE_MATRIX_DOMAIN=<KODERA_MATRIX_DOMAIN>`;
- admit those exact endpoints in its Content-Security-Policy `connect-src`: the identity provider, `https://api.<KODERA_MATRIX_DOMAIN>`, `wss://api.<KODERA_MATRIX_DOMAIN>/documents/collab`, `https://matrix.<KODERA_DOMAIN>`, `wss://livekit.<KODERA_DOMAIN>`, and, when external object-storage attachments are enabled, the exact `KODERA_ATTACHMENT_BASE` bucket prefix (`https://<storage-host>/<path>/`).

Register the Synapse callback of your realm's `synapse` client at the Matrix origin, `https://matrix.<KODERA_DOMAIN>/_synapse/client/oidc/callback`, and register the `console` client's callbacks on each configured web origin.

Status: the split topology is checked by the repository gate and its Caddy configuration is parsed by the pinned Caddy image; no deployment of it is rehearsed in this repository.

## Sign-in

`KODERA_CONSOLE_CLIENT_ID` selects the OAuth client used for owner/admin MFA
verification. Leave it empty to inherit `KODERA_OIDC_CLIENT_ID` (`console` by
default), or set it to exactly that same client ID. Both `server` and `migrate`
receive the nested fallback in both topologies. The preflight refuses mismatched
or malformed identifiers. In split deployments, build the separately hosted web
client with the same `KODERA_OIDC_CLIENT_ID`.

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

- the confidential client **`synapse`** of your realm, with the callback `https://<KODERA_DOMAIN>/_synapse/client/oidc/callback` (`https://matrix.<KODERA_DOMAIN>/…` in the split topology), PKCE S256 and back-channel logout;
- the Matrix localpart with the exact `{{ user.sub }}` template (Core ADR-0018), from the stable `sub` claim;
- the initial display name from the realm's `given_name` claim only: the community realm sets `registrationEmailAsUsername`, so `preferred_username` is the member's e-mail address and neither it nor the full `name` claim is ever shown; members can change it (`enable_set_displayname`), and later SSO sign-ins never overwrite it (`sso.update_profile_information` stays off);
- `sso.client_whitelist` holding the `/espace/callback` URL on each configured web origin. Synapse matches these prefixes when the client appends its sign-in state.

Which realm it is:

- **Canonical Community** (`KODERA_DEFAULT_COMMUNITY_ORG_SLUG=community`): the issuer is `KODERA_DEFAULT_COMMUNITY_ISSUER`. Leave `KODERA_SYNAPSE_OIDC_ISSUER` empty.
- **Isolated self-host:** set `KODERA_SYNAPSE_OIDC_ISSUER` to your realm's issuer, which must be admitted on the customer lane of `KODERA_AUTH_TRUST`, and `KODERA_SYNAPSE_OIDC_CLIENT_SECRET` to the secret your identity provider issued for the `synapse` client. The generator takes it with `--synapse-oidc-secret-file`.
- **Both empty:** Synapse starts with no sign-in at all. The control plane and the web client run, but nobody can open a Matrix session, so channels and audio rooms stay unavailable.

Synapse reads the realm's discovery document when it starts and refuses to start if it cannot reach it. A provider written by anyone else is never silently replaced: the start fails instead.

## What the internet can reach

Caddy is the only service that publishes HTTP ports. In the `single` topology it routes, on `KODERA_DOMAIN` (the `split` topology routes the same paths on the origins of "Topologies", has no web client and answers `404` on everything else):

| Path | To |
| :--- | :--- |
| `/api/*`, `/health/*`, `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` | the server API (via `api-admission`) |
| `/documents/collab` | `yjs-collab` WebSocket sync |
| `/_kodera/rooms/token` | `room-access` |
| `/_matrix/client/*`, `/_matrix/media/v3/upload`, `/_matrix/media/v3/upload/*`, `/_matrix/media/v1/create`, `/_matrix/media/v3/config`, `/_synapse/client/*` | Synapse's client API, authenticated media upload/create/config routes and sign-in callback |
| `/rtc`, `/rtc/*` | LiveKit signalling |
| everything else | the web client |

**Caddy alone names the client.** For every upstream it overwrites `X-Forwarded-For` with the address of the peer it accepted, and drops `X-Real-IP` and `Forwarded`: a value a client sends in those headers never reaches Synapse or the API. Caddy, `api-admission` and `server` share a dedicated three-member `api_ingress` bridge (`KODERA_API_INGRESS_SUBNET`, with Caddy pinned to `KODERA_CADDY_API_ADDRESS`, `api-admission` pinned to `KODERA_ADMISSION_API_ADDRESS` and trusting only `KODERA_CADDY_API_ADDRESS/32`, and `server` pinned to `KODERA_SERVER_API_ADDRESS` and trusting only `KODERA_ADMISSION_API_ADDRESS/32` so Docker IPAM cannot collide regardless of start order), while Caddy reaches the other fronted upstreams over `edge`. `api-admission` (`python -m config.edge_admission` inside a read-only `128m` container) buffers complete `<= 1 MiB` request bodies under a 10-second deadline and enforces fair shared-NAT per-client write admission before opening a connection to Gunicorn on `server:8000`, so trickling writers hold zero Gunicorn body-reader slots while per-client discovery and Passport quotas trust `X-Forwarded-For` exclusively across the static `api_ingress` chain and no sibling container can spoof that peer address. The `Caddyfile` declares no `trusted_proxies`, because nothing sits in front of Caddy in this profile; if you put your own proxy or load balancer in front, that is a change to review, since Caddy would then see the proxy's address as every client's. Only Caddy and LiveKit publish ports on the host. Synapse, the API and the databases are reachable on the stack's internal networks only, so the listener that believes the forwarded address cannot be called around Caddy.

It answers `404` on `/agent/*`, `/staff/*` and on every other `/_matrix/*` and `/_synapse/*` path. The agent API (`/agent/v1/...`) is for the tenant agent, which calls `http://server:8000` on the stack's internal network; Synapse's admin API (`/_synapse/admin/*`) is likewise reached by the agent only. LiveKit also publishes its media ports (7881/tcp, 50000–50200/udp), exactly those of `livekit.yaml`.

### Mobile app association

The server receives `KODERA_IOS_APP_IDS` and `KODERA_ANDROID_ASSETLINKS_SHA256`
from Compose in both topologies. Set these to identifiers and signing fingerprints
from your own signed mobile builds; the template leaves both empty.

`/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` leave their runtime defaults empty in version control so an unconfigured stack answers `503` (`well_known_unconfigured`) instead of advertising placeholder mobile signing identifiers. To enable iOS Universal Links and Android App Links for official Kodera native builds in operator-owned configuration (comments/examples only — keep uncommitted runtime defaults empty on isolated deployments):

```sh
# Official Kodera production mobile association example:
# KODERA_IOS_APP_IDS=UF5852SF57.io.kodera.app
# KODERA_ANDROID_PACKAGE_NAME=io.kodera.app
# KODERA_ANDROID_ASSETLINKS_SHA256=66:F3:3A:25:47:F5:4B:3E:DF:0F:BF:9A:E7:D9:C3:E7:F6:66:DB:92:FC:ED:82:F4:15:AE:CB:E1:56:4D:9E:F5
```

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

Status: closed by default. Explicit partner federation is experimental under proposed
SRV-ADR-0025 and requires operator review before deployment.

The ordinary Compose profiles expose client APIs only. Synapse's federation allowlist is empty,
no key server is trusted, and Caddy refuses federation/key/admin routes. Internal rooms are
created with immutable `m.federate: false` and a local-server ACL. The tenant agent does not
select any partner channel by default.

From a full source checkout, generate a separate opt-in overlay (generation changes no service):

```sh
python3 deploy/community/partner_federation.py --enable-partner-federation \
  --topology single --domain home.example.org --allow-server partner.example.org \
  --channels '{"11111111-1111-4111-8111-111111111111":["partner.example.org"]}' \
  --out /tmp/partner-config
```

Use actual Core channel UUIDs and reviewed public homeserver names. The map is bounded to
32 channels and 32 distinct servers per channel; every server must also appear in the global
`KODERA_MATRIX_FEDERATION_ALLOWLIST`. Ports, IPs, wildcards and private names are refused.
`KODERA_MATRIX_PARTNER_CHANNELS` and the global allowlist are public configuration, delivered to
the tenant agent and Synapse renderer with the same values. The source generator is intentionally
not added to the minimal `create-kodera` asset bundle; this experimental mode requires a full
checkout. The normal scaffolder remains closed and its existing asset parity gate still applies.

Review the generated README and files. Add `--env-file .env --env-file /tmp/partner-config/partner.env`
to Compose and apply `/tmp/partner-config/docker-compose.partner.yml` after the base profile
(and after the split profile when selected). It overrides only Caddy's reviewed configuration
mount. The generated routing opens exactly `/_matrix/federation/*` and `/_matrix/key/*`; admin
and internal agent routes remain closed. The single topology adds exact server discovery.
For `--topology split`, the separate web host must serve generated `matrix-server.json` at
`https://<KODERA_DOMAIN>/.well-known/matrix/server`; the generator does not configure that host.
Existing output directories and symlinks are refused rather than overwritten.

Only active text channels with Core audience `all`, no denied override and `read_only: false`
qualify. The agent creates a private invite-only room with both invitation flags true, explicit
immutable partner mode and an exact server ACL. Ordinary joined users may invite approved
partners through standard Matrix clients. Native room authorization, bans and encryption
restrictions remain in force; a partner identity receives no Core membership or document grant.
Foreign joined/invited users survive convergence only for that exact eligible channel and server.
An ineligible selection fails closed. Existing rooms without the matching immutable mode require
explicit replacement/migration; no creation flag is rewritten or history copied automatically.
Removing opt-in removes foreign membership and holds the old room for replacement.

Partner rooms use Matrix shared history. Removing an invitation or membership cannot retract
history already delivered; ACLs cannot establish retroactive outbound isolation for a formerly
federated room. Keep internal conversations in separate rooms. Verify deployed TLS, discovery,
peer policy and real-account acceptance before enabling this mode. The isolated two-homeserver
harness in `packages/synapse-policy/tests/integration/federation.py` exercises standard Matrix
protocol; it does not claim device testing of Element, Tchap or Cinny builds.

Validation: `python3 deploy/community/test_partner_federation.py` checks narrow routes,
discovery and 12 named refusal cases. The default community gate and its mutation self-tests
continue to reject open-by-default profiles.

## Images and limits

- Synapse installs `kodera-synapse-policy` 0.1.8 from the local read-only package mount on every start, with `--no-index --no-deps --no-build-isolation`. No package download occurs. Keep the repository's `packages/synapse-policy` directory beside this deployment tree.
- Fresh and existing Synapse configurations enable `kodera_synapse_policy.KoderaPolicy`. The tenant agent is `@kodera-agent:<domain>` and the occupancy writer is `@kodera-rooms:<domain>`; provision `ROOM_ACCESS_MATRIX_TOKEN` for that room-access account. The generated configuration preserves other operator modules and replaces the policy entry idempotently.
- Every pulled image is pinned by tag and digest (`name:tag@sha256:…`), matching the versions the CI runs where the CI runs them (Postgres 17.12, Synapse v1.165.0, LiveKit v1.13.11). The `server`, `migrate`, `room-access` and `web` images are built from this repository.
- Every service sets `mem_limit`.
- Synapse is rate limited (`rc_message`, `rc_registration`, `rc_login`, `rc_joins`, `rc_invites`). Every value is Synapse's documented default, written out so that a later default cannot loosen it, with one exception: **`rc_login.address` is 20 sign-ins, then one every 6 seconds**, where the default is 5, then one every 5.5 minutes. The default would lock out a team that shares one office address, and the web client signs in again on every reload. Password sign-in is off, so the only login an address can attempt is a single-use token that Synapse itself issued after your identity provider authenticated the member; failed attempts (`rc_login.failed_attempts`) and per-account sign-ins (`rc_login.account`) keep the default. The check refuses any value looser than these. One consequence of the per-account default: Synapse counts every sign-in of a member, a reload of the web client included, so a member who reloads more than five times in quick succession waits a few minutes for the next Matrix session.
- A per-address limit is only as good as the address. Synapse reads the client address from `X-Forwarded-For` on the one listener Caddy targets (port 8008) and on no other; see "What the internet can reach" for why that header can be believed.
- `scripts/ci/check-community-deploy.py` checks all of this, with the rest of this stack's invariants, on every change: it runs `configure_synapse.py` on fresh and existing homeserver settings, checks member-controlled display names with and without OIDC in both topologies, and refuses SQLite, an open federation, a missing policy module, missing or loosened rate limits, a route to `/agent/*`, and a default in `.env.example` or the Compose file that looks like a secret. `--selftest` proves each check can fail.
- The check refuses what it cannot follow, instead of passing over it. The Compose file is read as block mappings with reviewed keys only: an anchor, alias or merge key, an inline or quoted form, `env_file`, `extends`, `network_mode`, a new bind mount or a new build context is refused. The `Caddyfile` is held to its reviewed shape: one site block (`Caddyfile.split`: its three, each with its own upstreams and a `404` for the rest), single-line path matchers, the reviewed directives, and no `import` of anything but the snippet it defines. `livekit.yaml` is exactly its reviewed settings, and the Compose file publishes exactly its media ports. `docker-compose.split.yml` may change only the reviewed keys listed in "Topologies". A symbolic link in place of any of these files is refused and never followed. Changing one of them therefore means updating the check in the same change, which is the review.

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

`--topology split` writes the split topology's `.env` (see "Topologies") and prints the
origins the static web host must name; the default is `single`.

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
  logout, configured according to your identity provider's realm runbook.
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

The migration job also runs `configure_api_role` and `configure_collab_role`.
Set independent `KODERA_API_DATABASE_PASSWORD` and
`KODERA_COLLAB_DATABASE_PASSWORD` values of at least 32 random URL-safe
characters; never reuse `POSTGRES_PASSWORD`. The API connects as `kodera_api`
with the reviewed API writer grants; native collaboration connects as
`kodera_collab` with document-only column grants and bounded authorization/audit
functions. Provisioning refuses privileged logins and excessive grants. Runtime
connections refuse owner, elevated or masked database identities; a rejected API
connection is closed before application queries can use it. Migration and
bootstrap commands retain their separate schema authority. A refusal must be
investigated rather than bypassed.

Collaboration tickets expire within five minutes and admit exactly one socket.
Redeemed nonces persist in PostgreSQL across service instances and restarts;
expired entries are pruned during admission. A reconnect must mint a fresh ticket.
Only `/documents/collab` is public. `/internal/transform` stays on the internal
Compose network and requires the signed, short-lived application request MAC.

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

## Media attachment signing worker

Status: Implemented; provider credentials remain operator-provisioned

Django ingress applies `request_body { max_size 1MiB }` to API and association handles.
Caddy streams those bodies without body-placeholder reads or reverse-proxy request buffers.
Gunicorn uses two `gthread` workers with four threads and at most 32 connections each.
Before Django runs, each worker admits at most two concurrent body readers, buffers at most
1 MiB, and enforces a 10-second absolute read deadline (including trickling bodies). Saturated
readers receive `503` with `Retry-After: 1`; timeouts receive `408`, and oversized bodies `413`.
Refusals close the upstream connection without waiting for the remaining body. Successful reads
release their slot before Django runs, with the body in memory. This reserves two request threads
per worker for bodyless health and authenticated reads during slow-body pressure (four concurrent
slow-body streams — two per worker — still saturate body-carrying API writes with `503` while reads
stay up); it does not reserve capacity against expensive views or slow request headers. Add an edge
per-IP connection limit appropriate to shared NAT users, plus a global connection limit, before
exposing Community publicly. Caddy's bundled build does not provide a per-IP connection limiter;
use a qualified front proxy or firewall. Follow-up: [kodera#254](https://github.com/kodera-hq/kodera/issues/254).
Global Caddy timeouts are `read_header 10s`,
`read_body 300s`, and `idle 120s`: the body deadline bounds trickle connections while allowing
25 MiB Matrix uploads on 1 Mbit/s links. Matrix retains its upstream media size limits.
Run `python3 scripts/ci/smoke-community-ingress.py` against the cached pinned Caddy image;
`--static` checks configuration without Docker, `--gunicorn` exercises real slow-body admission
without Docker, and `--fast` skips the long Matrix case. Use the locked server Python environment.
The smoke uses real Gunicorn with a synthetic downstream view; the focused server concurrency
acceptance additionally exercises authenticated workspace, upload-ticket, subscription and preview
routes against PostgreSQL with synthetic external transports. Hosted CI runs the fast pinned-image
smoke. Gunicorn's `timeout = 30` monitors worker liveness in gthread mode, not individual requests:
PostgreSQL statements retain a 2-second timeout, and outbound operations have their own deadlines.
There is no universal 30-second request kill in this configuration.

URL previews and push DNS resolution each use a distinct non-blocking PostgreSQL advisory lease
across API processes. Lease connections must reach PostgreSQL directly, without a transaction-mode
pooler such as PgBouncer: session advisory locks cannot safely traverse transaction pooling.
Deployments using transaction pooling must set `KODERA_DATABASE_TRANSACTION_POOLER=1`; this
selects transaction-scoped leases on the disposable connection and rolls back before returning it,
so no session lock survives in a recycled server connection.
Application-side pooling is disabled on the disposable lease connection; a failed lease refuses
network work. Non-PostgreSQL tests retain process-local admission only. A principal has a
fixed-window budget of ten previews per minute (including cache hits), and a timed-out normalized
origin is refused for ten seconds across workers. These cluster-wide lanes are sized for Community;
hosted multi-tenant deployments need fairness between organisations. Neither guard needs Redis.

Uncompleted attachment tickets release quota at `upload_expires_at + 300 seconds` even without a
reaper. Completed attachments always count. The canonical `UPLOAD_STREAM_DRAIN_SECONDS = 300`
matches migration 0016's SQL; settings other than 300 are refused. S3-compatible providers do not
cap PUT stream duration. A PUT started before expiry can therefore land after the quota fence and
row cleanup. Organisation erasure also paginates `organisations/{org}/attachments/`, deletes orphaned
keys, and verifies a fresh prefix listing is empty. The worker credential must allow bucket listing
restricted with `s3:ListBucket` to `organisations/<org>/attachments/`; a refused listing keeps
erasure held. Listing uses ten keys per page and refuses more than 100,001 pagination iterations.
The prefix sweep runs only for whole-organisation erasure: its authoritative scope binds the
organisation's erasure journal, and upload tickets are refused once erasure begins. Account
erasure deletes its inventoried personal attachment keys individually, without a prefix sweep.
A periodic rowless-object sweep remains tracked in
[kodera#253](https://github.com/kodera-hq/kodera/issues/253). Erasure still requires authoritative inspection
that pre-expiry streams have drained; a prefix sweep cannot certify the absence of a future PUT.
Cancelled and expired tickets retain their key until the reaper confirms physical absence.

The API delegates attachment signing to `media-storage-worker` through
`/run/kodera-media/media.sock`, selected by `KODERA_MEDIA_GATEWAY_SOCKET`. It receives
only the read-only `media_socket` mount. The API and worker run as UID/GID
`10001:10001`; the directory is mode `0700` and the worker creates a mode `0600`
socket. Linux checks the socket inode's write permission when connecting; a
read-only mount permits this connection while preventing filesystem changes,
matching the proximity socket boundary.

`media-socket-init` establishes mode `0700` and ownership `10001:10001` on both
runtime directories before the worker starts while preserving any live worker socket. Its
root filesystem is read-only and its only capabilities are `CHOWN`, `FOWNER` and
`DAC_OVERRIDE`; the last permits ownership checks inside the existing owner-only directory.
The worker has no added capabilities, published ports or environment credentials.
The API waits for the worker's Unix socket connection healthcheck in both topologies.
An empty credential directory allows worker startup; the API's readiness probe
checks its database and does not require storage credentials. Attachment signing
without an organisation credential returns a retryable `503`.

`KODERA_MEDIA_SECRETS_SOURCE` defaults to the named `media_secrets` volume. To use
an operator-provisioned host directory, set it to an absolute path on the Docker
host, such as `/srv/kodera/media-secrets`; both services use that same source.
The initializer needs this mount writable to set directory permissions; the worker
receives it read-only. No other service receives it. The initializer never changes
credential file contents or recursively changes their ownership: provision files
readable by UID `10001` (normally owner `10001:10001`, mode `0600`). Each file is
named by its organisation UUID and contains `endpoint`, `bucket`, `region`,
`accessKey`, `secretKey` and optionally `sessionToken`. Use an HTTPS endpoint and a
private bucket; the worker loads credentials per operation. These values belong
only in the separately provisioned directory. When browser uploads or downloads
target that external HTTPS bucket directly in the single-origin topology, set
`KODERA_ATTACHMENT_BASE` in `.env` to the exact dedicated HTTPS bucket prefix
ending in `/` (for example `https://media.example.org/bucket/`, never the Core API
or identity-provider origin); `web` forwards it as `--attachment-base` so
`connect-src` admits only that path prefix.

`storage_worker.py` coordinates exclusive socket ownership through `media.sock.lock`
(non-blocking `flock`, mode `0600`, `O_NOFOLLOW`, UID-verified). If a live worker holds
`media.sock.lock`, a competing worker refuses to clobber the active socket; after an
abrupt worker termination (`SIGKILL` or power loss) its `unless-stopped` restart policy
acquires `media.sock.lock`, unlinks the unlocked stale `media.sock`, and rebinds cleanly
without rerunning `media-socket-init`. For a deliberate manual reset of the runtime
directories and worker:

```sh
docker compose stop server media-storage-worker
docker compose run --rm --no-deps media-socket-init
docker compose up -d media-storage-worker server
```

Use the same Compose files for these commands as for the running topology,
including `-f docker-compose.yml -f docker-compose.split.yml` for split deployments.
The local check
`PYTHONDONTWRITEBYTECODE=1 TMPDIR=/tmp python3 deploy/community/test_media_worker_startup.py`
exercises live-socket preservation, unlocked stale-socket recovery via `media.sock.lock`,
empty-directory startup, the actual health probe and signing refusal without contacting
a storage provider. It does not start the full Compose stack.

## Shared ephemeral proximity state

The customer API keeps two Gunicorn workers. Both delegate proximity bootstrap, check-in, resolution, checkout and replay admission to the `proximity-broker` process over `/run/proximity/broker.sock`. The socket directory is owner-only and mounted read-only by the API; it holds only the socket and an empty lifetime ownership lock. No beacon key, handle, status note or proximity presence is written there or into PostgreSQL. The broker has no published port, database credential or provider credential.

Missing socket configuration, an unavailable broker or a malformed/oversized response produces a fail-closed `503`; HTTP workers never create a replacement local broker. Broker restart erases all presence/replay state and replaces its random beacon key, so clients must bootstrap and opt in again. A lifetime lock refuses a second broker on the same socket. This topology shares state among processes mounting that socket; multi-host proximity brokerage is not implemented. Physical BLE/LAN interoperability remains a separate acceptance requirement.

Bootstrap exports only the current epoch MAC capability, with strict expiry at the next 900-second boundary. It never exports the workspace master key. Clients stop and clear their owned key material at expiry; offline revocation is bounded by the issued epoch. Fresh authenticated provisioning never extends the member's voluntary consent deadline.

Proximity operations keep current authority fences through the broker call and response construction. Successful peer disclosure reconciles every target and is bounded to 512 distinct identities; excess capacity returns `503`, never a partial authorization snapshot. The broker retains opaque identity UUIDs rather than raw issuer/subject claims. Ordinary departure removes presence while preserving the short replay tombstone; permanent erasure removes both.

Every newly admitted workspace/account erasure inventory requires the `proximity_ephemeral` receipt. A separately configured erasure worker must mount the same private socket with the reviewed UID and explicitly supply `ProximityWorkspaceErasureAdapter` or `ProximityAccountErasureAdapter`. No missing-service-as-empty fallback exists. The receipt covers logical absence from this live RAM-only service; it does not qualify other replicas, forensic RAM zeroization, physical radio interoperability or immediate offline revocation. Existing immutable erasure journals are not rewritten or retroactively certified by the new inventory migration.

### Optional EU diagnostics

Community deployments send no analytics by default. To offer optional diagnostics, add the public
`VITE_POSTHOG_KEY` ingestion key to the web image's build arguments, with
`VITE_POSTHOG_HOST=https://eu.i.posthog.com`, and append
`--telemetry-host https://eu.i.posthog.com` to the web service's existing command. Rebuild the image.
Never use a personal API key. The server refuses other telemetry hosts and admits only `/i/v0/e/`
in `connect-src`; the default command admits no analytics origin. No analytics SDK, replay,
autocapture or DOM reader is installed. Each member must also opt in under workspace privacy
settings, separately for each account and workspace in this browser. Withdrawing consent stops
collection, aborts pending delivery and discards the in-memory random session identifier.
Previously delivered events are subject to the operator's analytics retention and erasure policy.
See [the privacy specification](../../apps/web/docs/specs/privacy-first-telemetry.md).
