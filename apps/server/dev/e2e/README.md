# Live end-to-end environment

**Status:** Proposed · **Owner:** API seat · test only, never a deployment artefact

The stack a browser suite drives end to end: **browser → Console → Core → PostgreSQL**, with
**Keycloak** for both identity lanes and **Mailpit** catching every message. Core owns this
definition; the Console repository owns the suite and its configuration.

| Piece | What it is |
|---|---|
| `compose.yaml` | PostgreSQL, the migrated schema, the API image built from this repository's `Dockerfile`, Keycloak pinned to the digest `dev/identity_fixture.py` qualified, and Mailpit. Project `kodera-core-e2e`, loopback ports only, no named volume. |
| `realms/kodera-staff.json` | The staff realm `kodera-staff` (docs/specs/STAFF_IDENTITY.md §1): two staff accounts, for the two-person rule. |
| `realms/e2e-pilot.json` | One organisation realm, pre-created. It stands in for the identity operator's run of the realm tooling between `start_realm_bootstrap` and `complete_realm_bootstrap`, and follows the org-realm template: console client with PKCE, audience `kodera-server`, a code required at sign-in, and an `owner` plus a `member` account created **without credentials, with required actions**, as `bind_intended_owner` expects them (docs/specs/FIRST_OWNER_BOOTSTRAP.md §5.6). Its console client also carries the test-only registered-factor claim (below). |
| `make_trust.py` | Renders the realms with their keys and seeded codes, and derives `KODERA_AUTH_TRUST` (staff lane + customer lane), `KODERA_STAFF_ISSUER` and every other key and setting the API and `ops` read. `selftest` proves it offline, with Core's own parsers; `probe` proves the running stack. |
| `journey.py` | One entry point that takes the running stack to a fully journeyed organisation (below). |

## Test-only material, and why nothing secret is committed

Every signing key, password, one-time-code seed, Keycloak user id and admin password is derived
from one public label in `make_trust.py` (`SEED`). It is fixed — every run gets the same keys,
so Core's trust can pin them — and it is public: anyone can derive all of it, so nothing here is
a secret and **nothing derived from it may be trusted anywhere else**. The committed realm files
hold no key and no credential (`tests/test_e2e_environment.py` checks it); `render` writes the
complete imports, `compose.env` and `journey.json` under `rendered/`, which `.gitignore` already
excludes. That keeps private-key material out of the tree, so gitleaks and the private-key hook
need no allowlist entry.

Each realm signs with its own fixed **ES256** key (`defaultSignatureAlgorithm`), imported through
Keycloak's `ecdsa-generated` provider, which keeps a key pair it is given. The trust pins the
`kid` Keycloak derives itself (base64url SHA-256 of the public key's X.509 encoding); the probe
checks the live JWKS agrees. Declaring a key provider suppresses Keycloak's default ones, so the
HS512 and AES providers are declared too and generate their secrets at import.

### Second factor and `amr`

Both realms use a declared browser flow: cookie, or password **then a REQUIRED one-time code**.
An account without a code is made to configure one at its first sign-in, so the code is required
for everyone, not only for those who set one up. The two steps carry `amr` references (`pwd`,
`otp`) through `default.reference.value`, and the console client has the AMR mapper, so access
tokens carry `amr: ["pwd", "otp"]`. Core needs that: a staff principal is refused without `otp`,
`hwk` or `mfa` in `amr` (AUTHZ §3), and so is `consumeOwnerClaim`. The reference max age is ten
hours, the SSO maximum: Keycloak drops a reference older than its max age, and a max age of 0
expires it within the second.

A code is single-use (`otpPolicyCodeReusable: false`): a suite that signs the same account in
twice inside one 30-second step must wait for the next step.

### Owner modes

`render` defaults to `--owner-mode template`: `owner` and `member` have no credentials and the
required actions `UPDATE_PASSWORD` and `CONFIGURE_TOTP`, as the pilot binding (`bind_intended_owner`, FIRST_OWNER_BOOTSTRAP §5.6)
expects them. The
suite then plays the identity operator: an admin-API `execute-actions-email` for the account, the
link read from Mailpit, password and code set in Keycloak's own pages.

`--owner-mode test-credentials` is the **test-only variant**: both accounts get a derived password
and code, no required actions, `emailVerified: true`, and the realm's display name says
`[TEST-ONLY preset owner credentials]`. It exists so automation can sign the owner in while the
actions-e-mail path is not wired; it never describes a real organisation realm. **The journey
refuses it:** `bind_intended_owner` takes an account record with `credential_created: false`, and
an owner imported with credentials would make that record false. The journey keeps the template
owner credential-free for the binding, checked through the admin API, and only then gives it the
same derived password and code (`after_binding` in `journey.json`).

### The registered-factor claim

`consumeOwnerClaim` requires `kodera_mfa_enrolled: true` on a token whose `azp` is
`KODERA_CONSOLE_CLIENT_ID` (services/identity/access_tokens.py). In production a provider of
`identity realm tooling` (`kodera-registered-factor-v1`) will emit it (identity realm tooling #59, open) from the
user's stored OTP credential, on the organisation realm's console client only. The stock image here has no such provider, so
`realms/e2e-pilot.json`'s console client carries a **test-only stand-in**, the hardcoded-claim
mapper `e2e-test-only-registered-factor` (`kodera_mfa_enrolled`, boolean `true`, access token only).
It holds by construction in this realm alone: the browser flow requires a code of every user, so
every token it issues belongs to a user with an OTP credential. `selftest` refuses the realm
without it, with it set otherwise, and the staff realm with it. It is the one test-only exception
to the producer rule of `docs/specs/REGISTERED_FACTOR_SIGNAL.md` §2.

## Bringing it up (what a CI job runs)

From the repository root, with `uv` and Docker:

```sh
uv sync --frozen --group dev
uv run python -m dev.e2e.make_trust selftest          # offline proof, before anything starts
uv run python -m dev.e2e.make_trust render            # [--owner-mode test-credentials]
docker compose -f dev/e2e/compose.yaml --env-file dev/e2e/rendered/compose.env \
  up -d --build --wait                                # db, migrate, api, keycloak, mailpit
uv run python -m dev.e2e.make_trust probe             # live proof, below
uv run python -m dev.e2e.journey                      # a fully journeyed organisation, below
```

`--wait` returns when PostgreSQL answers, the migrations have exited 0, the API's
`/health/ready` answers 200 and Keycloak serves the discovery document of **both** realms (a
missing render fails here, not later). Interpolation without a render fails at once:
`compose.env` is required, and every derived variable is `:?`-guarded.

| Service | Loopback address | Notes |
|---|---|---|
| API | `http://localhost:8100` | `config.settings.e2e`: `config.settings.customer_http` (customer reads, the staff intake, `consumeOwnerClaim`, `discoverRealm`, the workspace), admitting the stack's loopback issuers and its plain-http Console origin |
| Keycloak | `http://localhost:8180` | `KC_HOSTNAME` fixes the issuer whoever asks: `http://localhost:8180/realms/<realm>`; it listens on that same port inside Mailpit's namespace |
| Mailpit | `http://localhost:8125` | UI and HTTP API (`/api/v1/messages`, `/api/v1/message/{id}`); SMTP is `mailpit:1025` to Keycloak and `localhost:1025` to `ops`, never published |
| PostgreSQL | not published | reached by `migrate`, `ops` and the API inside the network |

**The API's settings overlay.** The API image does not carry `config/settings/e2e.py`
(`.dockerignore`: the production build context stays closed). The `api` service mounts that one
tracked file, read-only, at `/app/config/settings/e2e.py`: the same explicit test-only overlay the
image qualification adds (`dev/accept_customer_http.py`), and the only host file the container sees
(`tests/test_e2e_environment.py` holds it exact). The profile also refuses to load unless it is the
selected settings module, and builds on `customer_http`, which refuses a non-local database.

**One loopback for the issuer.** `complete_realm_bootstrap` reads the realm at its issuer,
`http://localhost:8180/realms/e2e-pilot`, from inside `ops`, and `run_deliveries` sends plaintext
SMTP, which Core admits only to a loopback host. Mailpit therefore owns a network namespace that
Keycloak and `ops` join (`network_mode: service:mailpit`), Keycloak listens in it on its origin's
port, and Mailpit publishes that port to the host's loopback. Inside `ops`, `localhost:8180` is
Keycloak and `localhost:1025` is Mailpit; on the host, `localhost:8180` is Keycloak too. The issuer
is the same string everywhere, no proxy or host alias is involved, and no parser of Core's is
widened. `db` still resolves through the network's DNS.

Ports and origins are `render` options (`--keycloak-origin`, `--console-origin`, `--api-origin`,
`--mailpit-origin`); the issuer and the console redirect follow them. Keycloak runs as a nonroot
user and binds its origin's port itself, so `render` refuses a Keycloak port below 1024.

### What `probe` proves, and only a running stack can

1. Each realm's discovery document names the pinned issuer, and its JWKS publishes the pinned key
   under the pinned `kid` — Keycloak derived the same `kid`, so the trust matches the provider.
2. `staff-one` signs in through the real browser flow (authorization code + PKCE, password, then
   a code): the access token verifies through Core's own `verify_configured_token` on the
   **staff** lane, its issuer is `KODERA_STAFF_ISSUER`, its `sub` is the fixed id, and its `amr`
   holds `otp`.
3. In `test-credentials` mode, `owner` signs in the same way and verifies on the **customer** lane.
4. The API is ready, and `GET /api/v1/me` with the staff token is `403` of type `forbidden`, with
   no `WWW-Authenticate`: a staff token is no customer principal, and `getMe` answers verified
   staff authentication with `403` (`contracts/core-api.openapi.yaml`), never `identity-unknown`.
   `401` is only for a token that does not verify, and the probe proves it too: a bearer that is
   no token at all (`invalid-e2e-token`) is `401` of type `unauthenticated`, with a `Bearer`
   challenge.
5. In `test-credentials` mode, before any binding, `GET /api/v1/me` with the owner's token is `403`
   of type `identity-unknown`, with no `WWW-Authenticate`: the token verifies, but Core knows no
   identity for it.

**Unproven, and owed.** In the default `template` mode, nothing yet shows that the owner's
token carries `otp` in `amr` after the required-actions path: the actions e-mail runs
`UPDATE_PASSWORD` and `CONFIGURE_TOTP`, and whether the sign-in that follows passes through the
browser flow's tagged code step — and so gets the `otp` reference — has not been demonstrated.
`consumeOwnerClaim` refuses a token without it, so the claim step depends on this. The probe owes
a step for it (journey step 5a below). The journey does not take that path: after the binding it
gives the owner a derived password and code through the admin API (test only), and signs in
through the browser flow's tagged code step, which it checks for `otp` before the claim.

### Operator commands

The API image carries neither migrations nor commands. `migrate` and `ops` are the operator's
checkout (STAFF_IDENTITY §4): the `dependencies` stage of the same `Dockerfile`, this repository
mounted read-only, `config.settings.e2e_operator`: `config.settings.job_queue`, admitting the stack's loopback staff issuer.
`ops` also reads what the pilot's commands need (FIRST_OWNER_BOOTSTRAP §3.8, OUTBOX_MAIL_SENDER
§6): `KODERA_INTAKE_ADMITTED=1` (a disposable database), the API's contact seal key, the outbox
seal key, the Console origin the claim link may name, the claim landing
(`<console origin>/claim`, the Console's `/claim/<id>/<slug>` route) and Mailpit as the transport.

```sh
docker compose -f dev/e2e/compose.yaml --env-file dev/e2e/rendered/compose.env \
  run --rm ops bootstrap_staff_roles \
  --operator "$(jq -r '.accounts["staff-one"].subject' dev/e2e/rendered/journey.json)" staff-one@staff.kodera-e2e.test \
  --operator "$(jq -r '.accounts["staff-two"].subject' dev/e2e/rendered/journey.json)" staff-two@staff.kodera-e2e.test
```

`journey.json` is the suite's input: origins, the staff issuer, the organisation's slug and
issuer, the Keycloak admin, and each account's realm, username, fixed `sub`, address, and — when
preset — password and Base32 code seed (what an authenticator app is given). In template mode the
owner's `after_binding` holds the password and seed the journey sets after the binding.

## The scripted journey

After `up` (and `probe`), one command takes the stack to a fully journeyed organisation:

```sh
uv run python -m dev.e2e.journey
```

1. `ops bootstrap_staff_roles`: `staff-one` and `staff-two` become the first two staff operators.
2. `staff-one` signs in (password + code) and `POST /api/v1/organisations` records the intake of
   `e2e-pilot`, which enqueues its `realm_create` job.
3. `staff-two` runs `start_realm_bootstrap` through the six tooling steps (the realm is the
   pre-created one, so each outcome is `completed`), then `complete_realm_bootstrap`, whose verify
   reads the live realm's discovery document and key set and compares them with the pinned trust.
4. `staff-two`, not the recorder (the two-person rule), runs `bind_intended_owner` to the fixed
   `owner` subject, once the admin API has shown the account credential-free. The claim is issued
   and its mail enqueued.
5. **Test only**, standing in for the owner's actions e-mail: the admin API replaces the owner
   account, same id, with the representation `--owner-mode test-credentials` imports (derived
   password and code, no required action, verified address).
6. `ops run_deliveries --once` sends the claim mail to Mailpit; the token is the link's fragment.
7. `owner` signs in through the Console client; the journey checks the token with Core's verifier
   (customer lane, `otp`, verified address, `azp` = `console`, `kodera_mfa_enrolled`), then
   `POST /api/v1/owner-claims/actions/consume`.
8. `POST /api/v1/auth/discover` for `e2e-pilot` and the owner's `GET /api/v1/me` both answer `200`,
   with the realm named and an active `org_owner` membership.

`--until claim-mail` stops after step 6: the claim mail is in Mailpit and the claim is not
consumed, so the Console's own claim page (`/claim/<id>/<slug>`) can consume it in a browser (the
Console's v1 smoke, `tests/smoke/README.md` there).

It prints identifiers and outcomes, never a token or a password. It runs once per bring-up (the
staff bootstrap needs an empty staff table, and the journey refuses a stack whose organisation
discovery already answers): `down` and `up` to run it again.

### The invitation leg

On the same bring-up, after the journey:

```sh
uv run python -m dev.e2e.invitations
```

1. The owner invites `invitee@e2e-pilot.kodera-e2e.test` as `org_member`.
2. `ops run_realm_deliveries --once`, `ops send_invitations --once` and `ops run_deliveries --once`
   run, in the operator schedule's order. The realm worker (`kodera-identity-worker`, whose secret
   `render` writes under `rendered/realm-workers/`) creates the account with `VERIFY_EMAIL`,
   `UPDATE_PASSWORD` and `CONFIGURE_TOTP` and the invitation's locale, and has the realm mail the
   set-up link. The outbox then sends Core's invitation mail, which waits for that outcome. Both
   reach Mailpit.
3. The invitee follows the set-up link through the realm's own pages: the address is verified,
   then a password, a name and a code are set.
4. The invitee signs in (password and code) and posts the invitation token to
   `acceptInvitation`. `GET /api/v1/me` shows the active `org_member` membership. The same link
   again answers `409`.
5. The owner removes the membership, then `ops run_realm_deliveries --once` runs. The admin API
   shows the realm user disabled with no session, and the invitee's sign-in is refused.

The invitation mail links to `<console>/invitations/accept/<organisation id>/<slug>#<token>`.
`--until set-up` stops after step 3 for the Console's acceptance smoke: the invitation stays
pending with its mail in Mailpit, and the invitee's sign-in is written to `rendered/invitee.json`.

## Proposed CI job

Not in any workflow. Adding it touches `.github/workflows/`, so it needs the product owner's
explicit OK and an adversarial review at the exact head. Proposed as its own workflow, **optional
and never a required check**: triggered nightly, by hand, or by the `live-e2e` label on a pull
request, and kept out of `ci-ok`. It uses **no repository secret**: every value it needs is
derived by `render` from the public label. No artefact upload either — `rendered/` is test-only,
but it still holds credentials.

```yaml
name: Live end-to-end stack

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:
  pull_request:
    types: [labeled, synchronize]

permissions:
  contents: read

jobs:
  live-e2e-stack:
    name: Live end-to-end stack
    if: github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'live-e2e')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2 # v10.3.3
        with:
          python-version: "3.12"
          enable-cache: true
      - run: uv sync --frozen --group dev
      - name: Prove the trust offline before anything starts
        run: uv run python -m dev.e2e.make_trust selftest
      - name: Render the test-only realms and trust
        run: uv run python -m dev.e2e.make_trust render
      - name: Bring the stack up
        run: >-
          docker compose -f dev/e2e/compose.yaml --env-file dev/e2e/rendered/compose.env
          up -d --build --wait --wait-timeout 300
      - name: Probe the live stack
        run: uv run python -m dev.e2e.make_trust probe
      - name: Journey an organisation from the intake to the consumed owner claim
        run: uv run python -m dev.e2e.journey
      - name: Stack logs
        if: failure()
        run: docker compose -f dev/e2e/compose.yaml --env-file dev/e2e/rendered/compose.env logs --no-color
      - name: Tear down
        if: always()
        run: docker compose -f dev/e2e/compose.yaml --env-file dev/e2e/rendered/compose.env down --remove-orphans
```

The browser half (Console OIDC build, `vite preview` proxy, `playwright.live.config.ts`) belongs
to a Console workflow job that checks out Core at a pinned SHA and runs the same first five steps.

## The Console side

The Console is built and served by the Console's own job, against this stack:

- **Build in OIDC mode:** `VITE_AUTH_MODE=oidc`, `VITE_ENABLE_MSW=0`, `VITE_OIDC_CLIENT_ID=console`,
  `VITE_KEYCLOAK_URL=http://localhost:8180`, and `VITE_CORE_API_URL=http://localhost:4173/api/v1`
  — same origin as the page, so the browser never makes a cross-origin call to Core, which sends
  no CORS headers.
- **Serve with `vite preview` on 4173, proxying `/api/v1` to `http://localhost:8100`.** The
  Console's `vite.config.ts` has no preview proxy today; it needs one, switched on only by an
  explicit variable so an ordinary preview stays proxy-free. Either Host header passes Core's
  `DJANGO_ALLOWED_HOSTS` (`localhost`).
- **Redirects:** each realm's `console` client admits exactly `<console origin>/auth/callback`
  (the Console's `redirectUri()`), with the console origin as its web origin for the token
  endpoint's CORS.
- **Realm selection:** both realm names pass the Console's realm-hint rule, and
  `POST /api/v1/auth/discover` answers for `e2e-pilot` once the journey has run. The API admits
  the Console's `Origin`, `http://localhost:4173`, because `KODERA_CONSOLE_ORIGINS` names it and
  `config.settings.e2e` alone admits a plain-http loopback origin (`KODERA_CONSOLE_LOOPBACK_ORIGINS`);
  every deployable profile refuses one (`tests/test_e2e_console_origin.py`).
- **Suite:** `playwright.live.config.ts` in the Console repository, reading `journey.json`, with
  TOTP computed from the Base32 seed (RFC 6238, SHA-1, 6 digits, 30 s). Running it in the Console's
  CI is a workflow change there, and needs the owner's OK and an adversarial review.

## The journey the suite drives

"Exists" means Core has it on `main` today; the rest waits on the items named. Steps 1 to 6 and
the end state of step 6 are what `python -m dev.e2e.journey` drives (above).

| # | Step | Core today |
|---|---|---|
| 0 | Bring-up, `selftest`, `probe` | **Exists** |
| 1 | First two staff operators: `ops bootstrap_staff_roles` with the two fixed subjects | **Exists** (STAFF_IDENTITY §4); journey step 1 |
| 2 | Staff signs in to the Console (staff realm, password + code) | Sign-in **exists**; the staff screens are the Console's (C2) |
| 3 | Staff creates the organisation: intake, slug `e2e-pilot` reserved, `realm_create` job, audit | **Exists** (K6, `createOrganisation`, Core #164; the API admits the intake and seals the contact with a derived key); journey step 2 |
| 4 | Operator commands: `start_realm_bootstrap`, the tooling run (here: the pre-created realm), trust entry (here: already in `KODERA_AUTH_TRUST`), `complete_realm_bootstrap` | **Exists** (K7, FIRST_OWNER_BOOTSTRAP §5.5); journey step 3 |
| 5 | `bind_intended_owner` (second operator) to the fixed `owner` subject; owner sets password and code through Keycloak's actions e-mail, read from Mailpit | Binding **exists** (§5.6); journey step 4. The actions e-mail works in Keycloak; the journey sets the owner's credentials through the admin API instead (test only) |
| 5a | Probe, template mode: after the actions e-mail, the owner signs in and the token verifies on the customer lane with `otp` in `amr` and `emailVerified` set | **Owed** in `make_trust probe`; unproven (above) |
| 6 | Owner claim issued and mailed; the claim link read from Mailpit; Console claim landing; `consumeOwnerClaim` with a code-bearing token; recorder confirmation (`confirm_owner_contact`) | Issue, mail (`run_deliveries`), consume and confirmation **exist**; journey steps 4 to 8 drive all but the confirmation and the Console's landing (C3) |
| 7 | Owner opens `/{org}/workspace`: initialise and read the starter workspace | **Exists** (K5 contract, K9 `getWorkspace` and `initialiseWorkspace`); Console C4 |
| 8 | Owner invites a new address; both mails read from Mailpit | **Exists** (K11a, INVITATIONS.md); invitation leg steps 1 and 2; Console C5 |
| 9 | The invitee completes the actions e-mail, accepts and sees the workspace | Acceptance **exists** (K11b); invitation leg steps 3 and 4; the Console's acceptance page is C6 |

`GET /api/v1/me`, `GET /api/v1/organisations/{id}` and the membership directory answer the owner
once the binding (step 5) has stored the owner's identity, and its membership once the claim is
consumed (step 6). Before the binding, a customer read with a token that verifies is `403` of
type `identity-unknown` (no `WWW-Authenticate`; signing in again changes nothing), and `401` is
only for a token that fails verification.

### Open points this environment surfaces

- **Accounts for invitees.** Settled by INVITATIONS.md section 4: the realm worker creates the
  invitee's account with its required actions when the invitation is written. The pre-created
  `member` account is no longer needed by any step.
- **`emailVerified`.** `consumeOwnerClaim` needs a verified address. Completing Keycloak's actions
  e-mail is expected to mark the address verified; step 5a should assert it rather than assume it.
  The journey's test-only preset sets it, and checks it on the token before the claim.
- **Least privilege.** The API connects as the schema owner here. The image acceptance proves a
  read-only role; once K6 adds writes, the environment should connect as the role production
  will use.
