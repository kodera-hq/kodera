# Espace's test stack: a real Synapse, Keycloak and LiveKit

Status: in use from the first Espace change. Espace's chat and audio rooms are tested against a real homeserver and media server, not a mock: timeline bugs never show against one. This is the one exception to the Console's MSW-only rule (messaging-pilot design, E6). The rest of the Console keeps its mocks.

## What runs

`tests/espace/stack/compose.yaml`, project `kodera-espace`, everything on 127.0.0.1, every image pinned by digest:

| Service | Image | Port | Role |
|---|---|---|---|
| `synapse` | `matrixdotorg/synapse:v1.163.0` | 8008 | The homeserver `kodera.test` (client API only; not 8448, the federation port) |
| `postgres` | `postgres:16-alpine` | none | Synapse's database |
| `keycloak` | `quay.io/keycloak/keycloak:26.0.7`, as `identity realm tooling` runs it | 8180 | The organisation's realm `acme-sa`, with Synapse's confidential client |
| `livekit` | `livekit/livekit-server:v1.13.10` | 7880, 7881, UDP 50000–50020 | Audio rooms' media |

Synapse is configured as the pilot requires (Core ADR-0018, the design's §2):

- **Closed.** No federation listener and an empty federation allow-list; no open registration. Test users are created through the shared-secret admin API.
- **Access tokens that expire.** A refreshable one lives 5 minutes and a refresh token buys the next. A client that asks for no refresh token still gets one that lives an hour. The Console keeps tokens in memory only (§2.4).
- **Profiles readable by signed-in users only.**
- **No end-to-end encryption by default** (§2.5).
- **`forget_rooms_on_leave`.** A member who leaves cannot page back through the history (§2.1 item 4).
- **Authenticated media only** (ruling 3).
- **Sign-in through the organisation's Keycloak realm** (§2.4):
  - one OIDC provider, with PKCE, mapping the Matrix user ID from Keycloak's stable `sub`, never from the username;
  - the Console's dev origin (`CONSOLE_ORIGIN`, `http://127.0.0.1:5173`) in `sso.client_whitelist`, so Synapse returns the login token without asking. The entry ends with `/`. Synapse matches it as a prefix, so without the slash `http://127.0.0.1:5173.elsewhere.example/` would receive the token too. A tenant's config must keep it.

  Synapse runs in a container and calls Keycloak by its service name, while the browser reaches Keycloak on the host. So discovery is off, and each endpoint is named. `skip_verification` lets Synapse accept plain-HTTP endpoints on 127.0.0.1; a tenant's Synapse never carries it.

Some of these settings are Synapse's defaults today. They are written out anyway, so that an upgrade that changes a default cannot change the pilot.

LiveKit creates no room on its own (`auto_create: false`). Core's room-access service creates each room when it grants a token. It runs only with the `audio` profile (see "Audio rooms and removal, locally").

Keycloak's realm is imported from `tests/espace/stack/keycloak/`, and it has no users. Each sign-in test creates its own member through Keycloak's admin API. So every run tests Synapse's mapping of a first sign-in, which a member signed in before would skip.

## Use it

```bash
tests/espace/stack/bin/up.sh
```

```bash
node tests/espace/stack/smoke.mjs
```

```bash
npx vitest run --config vitest.espace.config.ts
```

```bash
tests/espace/stack/bin/down.sh
```

`bin/up.sh` fills `tests/espace/stack/.env` from `env.example`, with random throwaway secrets; git ignores it. A name that `env.example` gained later is appended, so an existing stack keeps its database password. It waits until every service passes its healthcheck. The stack binds the host's 127.0.0.1: in CI it runs on the runner itself, not inside a job `container:`, which could not reach those ports. `bin/down.sh` deletes the volumes, so every run starts from an empty homeserver.

`smoke.mjs` checks what a client can observe of those settings. It runs every check and exits non-zero if any failed:

- a login returns an expiring access token and a refresh token;
- a refresh buys a new access token;
- a login without a refresh token still expires;
- sign-in is offered through one identity provider;
- the SSO redirect goes to the realm's authorization endpoint, with PKCE;
- a profile needs a signed-in user;
- LiveKit answers;
- no federation or server-key endpoint answers (`M_UNRECOGNIZED`);
- a new room carries no `m.room.encryption`, with a positive control: the same read finds it in a room created encrypted;
- a message reaches the other member through `/sync`;
- media answers only on the authenticated endpoint;
- a member who left, was removed (kicked) or was banned gets `403` on the history within 2 s, and nothing posted after their departure reaches them on the way, through the history, `/event` or `/context`;
- a member whose account is deactivated, as leaving the organisation does, loses their access and refresh tokens at once (`401 M_UNKNOWN_TOKEN`) and cannot sign in again with a password (`403 M_FORBIDDEN`). Synapse 1.163 clears a deactivated account's password, so it refuses that sign-in as it refuses a wrong password: the code does not say why. Smoke and `closure.mjs` pin that one code, so an upgrade that answers otherwise is seen. The self-test's sign-in as an active member, which gets `200`, is what proves the clause.

**The consistency window.** Synapse forgets a left room in a background handler that follows the state stream, not inside the leave request. For a few milliseconds after a leave or a kick (6 to 437 ms measured on this stack over 270 departures, most under 50 ms; reads soon after a fresh start, or on a busy machine, are the slowest), the departed member can still page back, but Synapse clamps their pagination to their own departure: they read what they could already read, and nothing posted after it (0 of 270 departures leaked). The history checks therefore poll for the `403` with a 2 s deadline, and check every answer on the way. A ban is refused at once, whatever `forget_rooms_on_leave` says. Leaving the organisation has no window at all: deactivation removes the member's tokens before the admin call returns.

What this does not cover: a file whose `mxc://` address a removed member kept still downloads for any signed-in account of the instance (authenticated media checks sign-in, not room membership: the pilot limit Core ADR-0018 states); `/sync`, `/relations` and `/search` during the window; a sign-in through Keycloak after deactivation; what the member's browser already displayed; and the whole chain from an admin's click in Core through the tenant agent's kick, which the two-user closure test proves. The first nightly to fail this way read once, right after `/leave`, on a fresh runner: that read raced the handler.

The self-test runs copies of smoke that each break one check. Three of them break the organisation check, one clause each, and each must fail it: one leaves the account active, one refreshes with another member's live refresh token, and one signs in as another active member. Then it turns `forget_rooms_on_leave` off and asserts that the leave and removal checks fail at their deadline while the "nothing posted after" checks still pass on real answers of `200`; against that Synapse, three copies that turn the history, the `/event` and `/context` reads, and the earlier-message control onto the earlier message each fail those checks. The CI job that runs this stack carries these mutations as its self-test.

## In CI

The `espace` job in `ci.yml` starts the stack, runs `smoke.selftest.sh`, then `smoke.mjs`, then installs and runs Espace's client suite (`vitest.espace.config.ts`, `tests/espace/integration/`). That suite has two files:
- `store.test.ts` signs two members in, each with their own store and `/sync`, as two browsers would be, and checks what one does against the other's snapshot.
- `signin.test.ts` makes the browser's whole round trip through Synapse's SSO and Keycloak's own sign-in form, then hands the session to the store. The self-test restarts Synapse from a copy of its config with `forget_rooms_on_leave` off, and asserts that smoke fails with the history checks' messages.

- **Path-gated.** On a pull request the job runs when a changed file is under Espace's paths, and on every doubt. A merge to `main` follows the same rule, applied to the merged pull request's files. The paths are `ci-plan.py`'s `PATH_GATED`: the stack, Espace and the messaging surface, `src/auth/`, the CSP in `server/static.mjs`, the dependencies, the workflows and the plan itself. The plan names the skip and why; `ci-ok` accepts it only from that plan. `check-plan-coupling.py` pins the job:
  - its condition;
  - its five steps (start, self-test, smoke, install, client suite), in order and unconditional;
  - that it reads no secret and keeps no credential;
  - that its paths include the pipeline's own files.

  The other paths are proven by `ci-plan.selftest.py`, one fixture each.
- **Nightly.** `espace-nightly.yml` runs the same steps on `main` every night unless the head is already proven. A first job reads the workflow's own runs with `actions: read` and `.github/scripts/nightly-head.py` decides. A scheduled night is skipped only when all of these hold for the head:
  - the most recent completed run on it that ran the stack, of any event, succeeded. A manual run that failed makes the next night run again;
  - that run is less than a week old, so an intermittent failure cannot hide behind one lucky run;
  - a scheduled night has passed on it.

  A skipped night is not a run of the stack. It concludes `success`, but it restarts nothing, so the week's floor still comes. The runs are ordered by when they last started, so a run re-run red is the latest; the week counts from when a run was made. They are walked newest first until one decides, so weeks of skipped nights do not crowd a decision out. Any error, a date that does not parse, or a full page of runs that decides nothing, runs the stack and says why. So does a head job that failed: only a decision to skip skips. `nightly-head.selftest.py` (29 fixtures, each asserting the decision and its reason) runs first in the same job, and in `ci.yml`'s plan job, so a pull request that changes the decision proves it. The job that starts the stack holds only `contents: read`, which checkout uses and does not keep. A manual run of either workflow always runs it.
- **Drafts.** A draft pull request skips the job, like every job the plan may skip; marking it ready for review runs it under the path rule above.
- **No secret** reaches the job: no `secrets.*`, no token, and a checkout without credentials. It runs on the host runner, since the stack binds 127.0.0.1.

When Espace has Playwright specs, they join as a sharded matrix. Vouching for a matrix today requires a HEAVY job, so that change also extends `check-plan-coupling.py` to a path-gated voucher.

A red night is a red run on `main`'s Actions page and an email to the workflow's author; nothing blocks on it. The lead's session reads it.

## Audio rooms and removal, locally

Audio rooms need Core's room-access service, and removal is Core's tenant agent's work. Neither is in this repository, so both run from a Core checkout:

```bash
CORE_SRC=../kodera-core bash tests/espace/stack/bin/up.sh
```

```bash
node tests/espace/stack/closure.mjs
```

```bash
bash tests/espace/stack/closure.selftest.sh
```

With `CORE_SRC`, `bin/up.sh` also starts the `audio` profile:
- `room-access`, Core's `room_access/`;
- `edge`, an nginx serving the token call `POST /_kodera/rooms/token` on the homeserver's origin (127.0.0.1:8009), as Fleet's edge does, with everything else proxied to Synapse;
- the agent's administrator account (`@kodera-agent`) and room-access's own account (`@kodera-rooms`, the name Core and Fleet give it), through `bin/audio-accounts.mjs`.

`--profile audio` by hand needs `CORE_SRC` too: without it, `room-access` fails at once on its missing mount (`CORE_SRC-is-unset-name-a-Core-checkout`). Commands without the profile, CI's included, need no `CORE_SRC`. room-access installs PyJWT at Core's pin and wheel hash (`--require-hashes`).

`agent.py` hands each command to Core's real `tenant_agent.handlers.Handlers`, built from `CORE_SRC` as the agent builds it, against this stack. It leaves out the command loop, and Docs and Meet are stubs that converge nothing:
- `apply <channel-set.json>`: an `engine_set_channel_members` payload;
- `members <subject>…` and `deactivate <subject>`: the next `engine_set_member_subjects` payload, which the handler applies to Synapse and follows with the roster guard. A subject the set in force lists as inactive and `members` names is sent as released, as Core sends it (ADR-0016), and the handler reactivates the account.

It prints the handler's outcome (`status`, `artefacts`, …) and, for `apply`, what the channel pass reported and the rooms the agent holds. It exits 1 when the outcome is not `succeeded`.

Its state is under `tests/espace/stack/.agent-state/`, and it runs with a venv in `tests/espace/stack/.venv/` holding PyJWT at Core's pin and hash. `closure.mjs` makes that venv. Git ignores both.

`closure.mjs` registers four members and an outsider, and has the agent make one text channel and one audio channel for the four. It then checks:
- the rooms, their aliases, policy and power levels;
- a message from one member reaches another's `/sync`;
- each member gets a room token through the edge, for that room's call only. The outsider gets 403, and so does a request for the text channel;
- LiveKit holds the call's room.

Then it removes two members, each measured from the start of the agent call:
- **One member taken out of both channels (G2.7).** The member is kicked from both rooms. Their room token is refused, and their history read gets 403 within 2 s of the kick. Nothing posted afterwards reaches them, and the others keep their access. All of it within 5 s.
- **One member taken out of the organisation (G2.5, Synapse's side).** The account is deactivated. The member's access and refresh tokens and their room-token request are refused, a new sign-in is refused, and the account has left both rooms. All of it within 5 s.
- **One member taken out of the organisation and put back at once.** Synapse parts a deactivated account from its rooms in a background loop, and reactivating the account does not take it off that loop's list. The agent deactivates the member, reactivates them through Core's released path, and applies the channel set again. From the channel set's return to 5 s after the deactivation, every read of the member's membership in both rooms must be `join`. Then the member must get a room token and read what is posted afterwards. Deactivation deleted their sessions and cleared their password, so the new session comes from the admin API's sign-in on their behalf, standing in for the realm's.

The script prints each measured time. It exits 1 if a check failed, and 2 if the audio profile is not up.

Without WebRTC no participant can join a LiveKit call here. Removal from a live call is proven in two browsers (next section).

`closure.selftest.sh` runs four cases, each asserting the exit status and the `FAIL` line:
- the script, which passes;
- a copy whose second channel set keeps the member, which fails the kick check;
- a copy whose channel set after the reactivation leaves the member out, which fails the rejoin check;
- the script with the agent run from a Core checkout without the fix that joins room-access to a new audio room, which fails that check. The checkout is `CORE_MAIN`, by default a `core-main` directory beside this checkout, made with `git -C <core> worktree add --detach <path> origin/main`. Room-access itself stays the container's.

The local Synapse loads no `kodera_synapse_policy` module. The agent's admin join of room-access to an audio room is therefore not checked against that module here; it is verified on staging (SA-01).

**CI does not run any of this**: Console CI has no Core checkout. Run it by hand on a change to the stack, Espace's audio rooms or Core's agent.

## Two browsers in one audio room

The media half of the proof: Espace's real call controller (`src/features/espace/audio/call.ts`) in two Chromium contexts, with Chromium's fake microphone, against the same stack and Core's real agent.

```bash
CORE_SRC=../kodera-core bash tests/espace/stack/bin/up.sh
```

```bash
npx playwright test -c playwright.espace.config.ts
```

The config is its own, not the main suite's. It serves `tests/espace/audio/harness.html` from Vite's dev server on `127.0.0.1:5173`, the one origin room-access's CORS allows (`CONSOLE_ORIGIN`), and reuses a dev server already running there. The page imports the controller and exposes `window.espaceHarness`. Members' tokens go in through `page.evaluate`, never a URL, and what each member hears is read from WebRTC's own statistics.

`two-browsers.spec.ts` registers two members and an outsider, and has the agent make one audio channel for the two. It then checks:
- both join from a click, reach `connected` and see each other;
- they hear each other within 10 s. Each side's remote track receives bytes and sound energy over 1 s and plays in an `<audio>` element, and each microphone sends bytes;
- when one mutes, their microphone track is stopped (`ended`, so the browser's recording indicator goes off) and the other hears silence; after the unmute, the track is live again and the sound comes back;
- the outsider's join ends `failed`, `forbidden`;
- **G2.7, mid-call.** The agent applies a set without the second member. Within 5 s of the call's start, that member's call is `ended`, `removed`, the other's participants no longer list them, and their new join is `forbidden`;
- **G2.5, mid-call.** A third member joins the channel and the call. The agent applies a member set with them inactive (`agent.py deactivate`): it deactivates the account, then its roster guard removes them from the call. Within 5 s of the command's start, their call is `ended`, `removed`, and the other's participants no longer list them. Their new join is `unauthenticated`: room-access refuses the dead Matrix token, and the harness's refresh is refused, as a dead refresh token is;
- the remaining member leaves, and is `idle`.

It prints the measured times at the end: click to connected, connected to heard, and both removals.

**CI does not run it**, for the same reason as `closure.mjs`. Playwright is a heavy job on a shared machine.

## For the Console in the browser

Run the Console's dev server (`npm run dev`, which serves no CSP) with `VITE_MATRIX_DOMAIN` set, `VITE_ESPACE_DEV_HOMESERVER=http://127.0.0.1:8009` (the edge, so room tokens work) and `VITE_ESPACE_DEV_SERVER_NAME=kodera.test`. Both overrides are read in development builds only. The dev server and `public_baseurl` must name the same host: `127.0.0.1`, not `localhost`. A production build reaches homeservers only through discovery under `--matrix-domain`, behind the CSP that `server/static.mjs` emits.
